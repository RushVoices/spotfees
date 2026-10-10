//! Stacks: split a token's creator fees into ten Stacks and sell them by
//! descending-price auction.
//!
//! How fees reach Stack holders
//! ----------------------------
//! Each launch has ten "vault" addresses, one per Stack (PDA seeds
//! `["vault", mint, index]`). They are plain system accounts that only this
//! program can spend from.
//!
//! * Pump: the coin's Pump fee-sharing config is set (once, permanently) to
//!   these ten vaults at 1,000 bps each. Pump's permissionless
//!   `distribute_creator_fees_v2` then pays SOL straight into the vaults.
//! * Meteora (Dynamic Bonding Curve): the pool's creator is transferred to a
//!   program-owned fee authority (PDA `["fee_auth", mint]`). Anyone can call
//!   `harvest_meteora`, which claims the creator trading fees and splits them
//!   equally into the ten vaults.
//!
//! Owning a Stack is a record in the `Launch` account. Taking, transferring or
//! claiming a Stack never touches Pump's or Meteora's configuration, which is
//! fixed before the auction opens. `open_auction_*` verifies that wiring
//! on-chain, so buyers do not have to trust the creator.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_lang::system_program;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};

declare_id!("3jFsMVZrjS6GVwQxh6wQGb71ubnBip6EBFxo9mydt3t3");

pub const NUM_STACKS: usize = 10;
pub const MAX_PREBUY: u8 = 5;
pub const STEP_SECONDS: i64 = 15;
pub const SHARE_BPS_PER_STACK: u16 = 1_000;
pub const MAX_PROTOCOL_FEE_BPS: u16 = 1_000; // hard cap: 10%

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Pump bonding-curve program.
pub const PUMP_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/// Pump fees program (owns `sharing_config`).
pub const PUMP_FEES_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
/// Meteora Dynamic Bonding Curve program.
pub const DBC_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// Wrapped SOL mint.
pub const WSOL_MINT: Pubkey =
    anchor_lang::solana_program::pubkey!("So11111111111111111111111111111111111111112");

// --- Foreign account layouts (from the programs' published IDLs / source) ---

/// Pump `BondingCurve` discriminator (pump.json).
const PUMP_BONDING_CURVE_DISC: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
/// 8 disc + 5 x u64 reserves/supply + 1 `complete` = 49.
const PUMP_BC_CREATOR_OFFSET: usize = 49;

/// Pump fees `SharingConfig` discriminator (pump_fees.json).
const PUMP_SHARING_CONFIG_DISC: [u8; 8] = [216, 74, 9, 0, 56, 140, 93, 75];

/// Meteora DBC `VirtualPool` (zero-copy) offsets: 8 disc + 64 volatility tracker.
const DBC_POOL_CONFIG_OFFSET: usize = 72;
const DBC_POOL_CREATOR_OFFSET: usize = 104;
const DBC_POOL_BASE_MINT_OFFSET: usize = 136;
const DBC_POOL_LEN: usize = 8 + 416;

#[program]
pub mod stacks {
    use super::*;

    /// One-time setup of the protocol config. The signer becomes admin.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        require!(
            params.protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            StacksError::FeeTooHigh
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = params.treasury;
        config.protocol_fee_bps = params.protocol_fee_bps;
        config.launch_fee_lamports = params.launch_fee_lamports;
        config.meteora_config = params.meteora_config;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin-only update of protocol settings. Never affects existing Stacks'
    /// fee streams; only future take/launch fees.
    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
        require!(
            params.protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            StacksError::FeeTooHigh
        );
        let config = &mut ctx.accounts.config;
        config.treasury = params.treasury;
        config.protocol_fee_bps = params.protocol_fee_bps;
        config.launch_fee_lamports = params.launch_fee_lamports;
        config.meteora_config = params.meteora_config;
        Ok(())
    }

    pub fn set_admin(ctx: Context<UpdateConfig>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// Registers a launch for a freshly created coin. Must run while the
    /// signer is still the coin's creator on Pump / Meteora, i.e. before the
    /// fee wiring is handed to the vaults. This stops anyone else from
    /// registering someone else's coin.
    ///
    /// remaining_accounts: the ten Stack vaults, in index order (writable).
    pub fn create_launch<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateLaunch<'info>>,
        venue: u8,
        mode: u8,
        prebuy: u8,
    ) -> Result<()> {
        let venue = Venue::try_from(venue)?;
        let (start, floor, drop) = mode_prices(mode)?;
        require!(prebuy <= MAX_PREBUY, StacksError::TooManyPrebuys);

        let mint = ctx.accounts.mint.key();
        let creator = ctx.accounts.creator.key();
        let venue_ai = &ctx.accounts.venue_account;

        // Prove the signer is the coin's creator on the chosen venue.
        match venue {
            Venue::Pump => {
                let (expected, _) = Pubkey::find_program_address(
                    &[b"bonding-curve", mint.as_ref()],
                    &PUMP_PROGRAM_ID,
                );
                require_keys_eq!(venue_ai.key(), expected, StacksError::WrongVenueAccount);
                require_keys_eq!(
                    *venue_ai.owner,
                    PUMP_PROGRAM_ID,
                    StacksError::WrongVenueAccount
                );
                let data = venue_ai.try_borrow_data()?;
                require!(
                    data.len() >= PUMP_BC_CREATOR_OFFSET + 32
                        && data[..8] == PUMP_BONDING_CURVE_DISC,
                    StacksError::WrongVenueAccount
                );
                let bc_creator = read_pubkey(&data, PUMP_BC_CREATOR_OFFSET);
                require_keys_eq!(bc_creator, creator, StacksError::NotCoinCreator);
            }
            Venue::Meteora => {
                require_keys_eq!(
                    *venue_ai.owner,
                    DBC_PROGRAM_ID,
                    StacksError::WrongVenueAccount
                );
                let data = venue_ai.try_borrow_data()?;
                require!(
                    data.len() >= DBC_POOL_LEN && data[..8] == account_disc("VirtualPool"),
                    StacksError::WrongVenueAccount
                );
                require_keys_eq!(
                    read_pubkey(&data, DBC_POOL_CONFIG_OFFSET),
                    ctx.accounts.config.meteora_config,
                    StacksError::WrongMeteoraConfig
                );
                require_keys_eq!(
                    read_pubkey(&data, DBC_POOL_BASE_MINT_OFFSET),
                    mint,
                    StacksError::WrongVenueAccount
                );
                require_keys_eq!(
                    read_pubkey(&data, DBC_POOL_CREATOR_OFFSET),
                    creator,
                    StacksError::NotCoinCreator
                );
            }
        }

        // Launch fee + protocol fee on pre-bought Stacks go to the treasury.
        // (The creator would otherwise pay the rest of the pre-buy price to
        // themselves, so it is not moved.)
        let config = &ctx.accounts.config;
        let prebuy_value = floor
            .checked_mul(prebuy as u64)
            .ok_or(StacksError::MathOverflow)?;
        let treasury_due = config
            .launch_fee_lamports
            .checked_add(bps_of(prebuy_value, config.protocol_fee_bps)?)
            .ok_or(StacksError::MathOverflow)?;
        if treasury_due > 0 {
            pay(
                &ctx.accounts.creator.to_account_info(),
                &ctx.accounts.treasury.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                treasury_due,
            )?;
        }

        // Fund the ten vaults to the rent-exempt minimum so they can receive
        // any payout size from Pump.
        require!(
            ctx.remaining_accounts.len() == NUM_STACKS,
            StacksError::WrongVaultCount
        );
        let rent_min = Rent::get()?.minimum_balance(0);
        let mut vault_bumps = [0u8; NUM_STACKS];
        for (i, vault) in ctx.remaining_accounts.iter().enumerate() {
            let (expected, bump) = vault_address(&mint, i as u8);
            require_keys_eq!(vault.key(), expected, StacksError::WrongVault);
            require!(vault.is_writable, StacksError::WrongVault);
            vault_bumps[i] = bump;
            let have = vault.lamports();
            if have < rent_min {
                pay(
                    &ctx.accounts.creator.to_account_info(),
                    vault,
                    &ctx.accounts.system_program.to_account_info(),
                    rent_min - have,
                )?;
            }
        }

        let (_, fee_auth_bump) = fee_auth_address(&mint);
        let now = Clock::get()?.unix_timestamp;
        let launch = &mut ctx.accounts.launch;
        launch.mint = mint;
        launch.creator = creator;
        launch.venue = venue as u8;
        launch.venue_account = venue_ai.key();
        launch.mode = mode;
        launch.status = Status::Setup as u8;
        launch.start_price = start;
        launch.floor_price = floor;
        launch.drop_per_step = drop;
        launch.created_at = now;
        launch.clock_start = now;
        launch.owners = [Pubkey::default(); NUM_STACKS];
        launch.paid = [0; NUM_STACKS];
        for i in 0..prebuy as usize {
            launch.owners[i] = creator;
            launch.paid[i] = floor;
        }
        launch.sold = prebuy;
        launch.bump = ctx.bumps.launch;
        launch.vault_bumps = vault_bumps;
        launch.fee_auth_bump = fee_auth_bump;
        launch.total_harvested = 0;

        emit!(LaunchCreated {
            mint,
            creator,
            venue: venue as u8,
            mode,
            prebuy
        });
        Ok(())
    }

    /// Opens the auction once Pump's fee sharing points at the ten vaults,
    /// 10% each, and can no longer be changed. Permissionless.
    pub fn open_auction_pump(ctx: Context<OpenAuctionPump>) -> Result<()> {
        let launch = &mut ctx.accounts.launch;
        require!(launch.venue == Venue::Pump as u8, StacksError::WrongVenue);
        require!(
            launch.status == Status::Setup as u8,
            StacksError::NotInSetup
        );

        let sc = &ctx.accounts.sharing_config;
        let (expected, _) = Pubkey::find_program_address(
            &[b"sharing-config", launch.mint.as_ref()],
            &PUMP_FEES_PROGRAM_ID,
        );
        require_keys_eq!(sc.key(), expected, StacksError::WrongVenueAccount);
        require_keys_eq!(
            *sc.owner,
            PUMP_FEES_PROGRAM_ID,
            StacksError::WrongVenueAccount
        );

        let data = sc.try_borrow_data()?;
        let parsed = parse_sharing_config(&data)?;
        require_keys_eq!(parsed.mint, launch.mint, StacksError::WrongVenueAccount);
        require!(parsed.active, StacksError::FeeSharingNotActive);
        require!(parsed.admin_revoked, StacksError::FeeSharingNotLocked);
        require!(
            parsed.shareholders.len() == NUM_STACKS,
            StacksError::FeeSharingMismatch
        );
        for (i, (addr, bps)) in parsed.shareholders.iter().enumerate() {
            let (vault, _) = vault_address(&launch.mint, i as u8);
            require_keys_eq!(*addr, vault, StacksError::FeeSharingMismatch);
            require!(*bps == SHARE_BPS_PER_STACK, StacksError::FeeSharingMismatch);
        }

        launch.status = Status::Open as u8;
        launch.clock_start = Clock::get()?.unix_timestamp;
        emit!(AuctionOpened { mint: launch.mint });
        Ok(())
    }

    /// Opens the auction once the Meteora pool's creator is this launch's fee
    /// authority, which only this program can sign for. Permissionless.
    pub fn open_auction_meteora(ctx: Context<OpenAuctionMeteora>) -> Result<()> {
        let launch = &mut ctx.accounts.launch;
        require!(
            launch.venue == Venue::Meteora as u8,
            StacksError::WrongVenue
        );
        require!(
            launch.status == Status::Setup as u8,
            StacksError::NotInSetup
        );

        let pool = &ctx.accounts.pool;
        require_keys_eq!(
            pool.key(),
            launch.venue_account,
            StacksError::WrongVenueAccount
        );
        require_keys_eq!(*pool.owner, DBC_PROGRAM_ID, StacksError::WrongVenueAccount);
        let data = pool.try_borrow_data()?;
        require!(data.len() >= DBC_POOL_LEN, StacksError::WrongVenueAccount);
        let (fee_auth, _) = fee_auth_address(&launch.mint);
        require_keys_eq!(
            read_pubkey(&data, DBC_POOL_CREATOR_OFFSET),
            fee_auth,
            StacksError::FeeSharingMismatch
        );

        launch.status = Status::Open as u8;
        launch.clock_start = Clock::get()?.unix_timestamp;
        emit!(AuctionOpened { mint: launch.mint });
        Ok(())
    }

    /// Buys an open Stack at the current auction price. `max_price` is the
    /// most the buyer accepts (the price their screen showed).
    pub fn take_stack(ctx: Context<TakeStack>, index: u8, max_price: u64) -> Result<()> {
        let i = index as usize;
        require!(i < NUM_STACKS, StacksError::BadIndex);
        let now = Clock::get()?.unix_timestamp;

        let launch = &ctx.accounts.launch;
        require!(
            launch.status == Status::Open as u8,
            StacksError::AuctionNotOpen
        );
        require!(
            launch.owners[i] == Pubkey::default(),
            StacksError::StackTaken
        );

        let price = current_price(
            launch.start_price,
            launch.floor_price,
            launch.drop_per_step,
            launch.clock_start,
            now,
        );
        require!(price <= max_price, StacksError::PriceAboveMax);

        let fee = bps_of(price, ctx.accounts.config.protocol_fee_bps)?;
        let to_creator = price - fee;
        let buyer = ctx.accounts.buyer.to_account_info();
        let sys = ctx.accounts.system_program.to_account_info();
        if fee > 0 {
            pay(&buyer, &ctx.accounts.treasury.to_account_info(), &sys, fee)?;
        }
        if to_creator > 0 && ctx.accounts.buyer.key() != launch.creator {
            pay(
                &buyer,
                &ctx.accounts.creator.to_account_info(),
                &sys,
                to_creator,
            )?;
        }

        let launch = &mut ctx.accounts.launch;
        launch.owners[i] = ctx.accounts.buyer.key();
        launch.paid[i] = price;
        launch.sold += 1;
        // The next open Stack starts again from the start price.
        launch.clock_start = now;
        if launch.sold as usize == NUM_STACKS {
            launch.status = Status::SoldOut as u8;
        }

        emit!(StackTaken {
            mint: launch.mint,
            index,
            buyer: ctx.accounts.buyer.key(),
            price,
            protocol_fee: fee,
        });
        Ok(())
    }

    /// Withdraws everything a Stack's vault has earned to its owner.
    pub fn claim(ctx: Context<Claim>, index: u8) -> Result<()> {
        let i = index as usize;
        require!(i < NUM_STACKS, StacksError::BadIndex);
        let launch = &ctx.accounts.launch;
        require_keys_eq!(
            launch.owners[i],
            ctx.accounts.owner.key(),
            StacksError::NotStackOwner
        );
        let (expected, _) = vault_address(&launch.mint, index);
        require_keys_eq!(ctx.accounts.vault.key(), expected, StacksError::WrongVault);

        let rent_min = Rent::get()?.minimum_balance(0);
        let amount = ctx.accounts.vault.lamports().saturating_sub(rent_min);
        require!(amount > 0, StacksError::NothingToClaim);

        let mint = launch.mint;
        let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &[index], &[launch.vault_bumps[i]]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(FeesClaimed {
            mint,
            index,
            owner: ctx.accounts.owner.key(),
            amount
        });
        Ok(())
    }

    /// Moves a Stack (and its unclaimed earnings) to another wallet.
    pub fn transfer_stack(ctx: Context<TransferStack>, index: u8, new_owner: Pubkey) -> Result<()> {
        let i = index as usize;
        require!(i < NUM_STACKS, StacksError::BadIndex);
        require!(new_owner != Pubkey::default(), StacksError::BadNewOwner);
        let launch = &mut ctx.accounts.launch;
        require_keys_eq!(
            launch.owners[i],
            ctx.accounts.owner.key(),
            StacksError::NotStackOwner
        );
        launch.owners[i] = new_owner;
        emit!(StackTransferred {
            mint: launch.mint,
            index,
            from: ctx.accounts.owner.key(),
            to: new_owner
        });
        Ok(())
    }

    /// Claims the Meteora pool's creator trading fees (quote side, in SOL)
    /// and splits them equally into the ten Stack vaults. Permissionless; the
    /// caller pays a temporary token account rent that is refunded here.
    ///
    /// remaining_accounts: the ten Stack vaults, in index order (writable).
    pub fn harvest_meteora<'info>(
        ctx: Context<'_, '_, 'info, 'info, HarvestMeteora<'info>>,
    ) -> Result<()> {
        let launch = &ctx.accounts.launch;
        require!(
            launch.venue == Venue::Meteora as u8,
            StacksError::WrongVenue
        );
        require!(
            launch.status != Status::Setup as u8,
            StacksError::AuctionNotOpen
        );
        require_keys_eq!(
            ctx.accounts.pool.key(),
            launch.venue_account,
            StacksError::WrongVenueAccount
        );
        require!(
            ctx.remaining_accounts.len() == NUM_STACKS,
            StacksError::WrongVaultCount
        );

        let mint = launch.mint;
        let fee_auth_seeds: &[&[u8]] = &[b"fee_auth", mint.as_ref(), &[launch.fee_auth_bump]];

        // 1. Claim creator fees (quote only) into the fee authority's wSOL account.
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&ix_disc("claim_creator_trading_fee"));
        data.extend_from_slice(&0u64.to_le_bytes()); // max_base_amount
        data.extend_from_slice(&u64::MAX.to_le_bytes()); // max_quote_amount
        let a = &ctx.accounts;
        let ix = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(a.pool_authority.key(), false),
                AccountMeta::new(a.pool.key(), false),
                AccountMeta::new(a.fee_auth_base.key(), false),
                AccountMeta::new(a.fee_auth_quote.key(), false),
                AccountMeta::new(a.base_vault.key(), false),
                AccountMeta::new(a.quote_vault.key(), false),
                AccountMeta::new_readonly(a.base_mint.key(), false),
                AccountMeta::new_readonly(a.quote_mint.key(), false),
                AccountMeta::new_readonly(a.fee_auth.key(), true),
                AccountMeta::new_readonly(a.token_program.key(), false),
                AccountMeta::new_readonly(a.token_program.key(), false),
                AccountMeta::new_readonly(a.dbc_event_authority.key(), false),
                AccountMeta::new_readonly(a.dbc_program.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                a.pool_authority.to_account_info(),
                a.pool.to_account_info(),
                a.fee_auth_base.to_account_info(),
                a.fee_auth_quote.to_account_info(),
                a.base_vault.to_account_info(),
                a.quote_vault.to_account_info(),
                a.base_mint.to_account_info(),
                a.quote_mint.to_account_info(),
                a.fee_auth.to_account_info(),
                a.token_program.to_account_info(),
                a.dbc_event_authority.to_account_info(),
                a.dbc_program.to_account_info(),
            ],
            &[fee_auth_seeds],
        )?;

        ctx.accounts.fee_auth_quote.reload()?;
        let amount = ctx.accounts.fee_auth_quote.amount;
        if amount == 0 {
            return Ok(());
        }

        // 2. Unwrap: close the wSOL account into the fee authority.
        let before = ctx.accounts.fee_auth.lamports();
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.fee_auth_quote.to_account_info(),
                destination: ctx.accounts.fee_auth.to_account_info(),
                authority: ctx.accounts.fee_auth.to_account_info(),
            },
            &[fee_auth_seeds],
        ))?;
        let gained = ctx.accounts.fee_auth.lamports() - before;
        let rent_refund = gained.saturating_sub(amount);

        // 3. Split equally; the remainder of the division goes to Stack 10.
        let share = amount / NUM_STACKS as u64;
        let dust = amount - share * NUM_STACKS as u64;
        let sys = ctx.accounts.system_program.to_account_info();
        for (i, vault) in ctx.remaining_accounts.iter().enumerate() {
            let (expected, _) = vault_address(&mint, i as u8);
            require_keys_eq!(vault.key(), expected, StacksError::WrongVault);
            let pay_amount = if i == NUM_STACKS - 1 {
                share + dust
            } else {
                share
            };
            if pay_amount > 0 {
                pay_signed(
                    &ctx.accounts.fee_auth.to_account_info(),
                    vault,
                    &sys,
                    pay_amount,
                    fee_auth_seeds,
                )?;
            }
        }
        // 4. Refund the temporary account rent to the caller.
        if rent_refund > 0 {
            pay_signed(
                &ctx.accounts.fee_auth.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &sys,
                rent_refund,
                fee_auth_seeds,
            )?;
        }

        let launch = &mut ctx.accounts.launch;
        launch.total_harvested = launch.total_harvested.saturating_add(amount);
        emit!(FeesHarvested { mint, amount });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub launch_fee_lamports: u64,
    pub meteora_config: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub launch_fee_lamports: u64,
    /// The Meteora DBC config every Meteora launch must use (creator fee
    /// share = 100%, set up by `scripts/create-meteora-config.ts`).
    pub meteora_config: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub venue: u8,
    /// Pump bonding curve or Meteora virtual pool.
    pub venue_account: Pubkey,
    pub mode: u8,
    pub status: u8,
    pub start_price: u64,
    pub floor_price: u64,
    pub drop_per_step: u64,
    pub created_at: i64,
    /// Auction clock: price steps are counted from here.
    pub clock_start: i64,
    /// `Pubkey::default()` = not sold yet.
    pub owners: [Pubkey; NUM_STACKS],
    pub paid: [u64; NUM_STACKS],
    pub sold: u8,
    pub bump: u8,
    pub vault_bumps: [u8; NUM_STACKS],
    pub fee_auth_bump: u8,
    pub total_harvested: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: must be the treasury named in config.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: the coin's mint; tied to the venue account in the handler.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Pump bonding curve or Meteora pool; verified in the handler.
    pub venue_account: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Launch::INIT_SPACE,
        seeds = [b"launch", mint.key().as_ref()],
        bump
    )]
    pub launch: Account<'info, Launch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenAuctionPump<'info> {
    #[account(mut, seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: Pump fees `sharing_config`; verified in the handler.
    pub sharing_config: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OpenAuctionMeteora<'info> {
    #[account(mut, seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: Meteora virtual pool; verified in the handler.
    pub pool: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TakeStack<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: receives the sale proceeds.
    #[account(mut, address = launch.creator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: receives the protocol fee.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: the Stack's vault PDA; verified in the handler.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferStack<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
}

#[derive(Accounts)]
pub struct HarvestMeteora<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: program-owned signer that is the Meteora pool's creator.
    #[account(mut, seeds = [b"fee_auth", launch.mint.as_ref()], bump = launch.fee_auth_bump)]
    pub fee_auth: UncheckedAccount<'info>,
    /// Fee authority's wSOL account (create it idempotently before this ix).
    #[account(mut, token::mint = quote_mint, token::authority = fee_auth)]
    pub fee_auth_quote: Account<'info, TokenAccount>,
    /// Fee authority's base-token account (required by Meteora; base fees
    /// are not claimed).
    #[account(mut, token::mint = base_mint, token::authority = fee_auth)]
    pub fee_auth_base: Account<'info, TokenAccount>,
    /// CHECK: verified against the launch.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: Meteora pool authority; checked by Meteora.
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked by Meteora.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: checked by Meteora.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: must be the launch's mint.
    #[account(address = launch.mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL only.
    #[account(address = WSOL_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Meteora event authority; checked by Meteora.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DBC program.
    #[account(address = DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Types, events, errors
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Venue {
    Pump = 0,
    Meteora = 1,
}

impl TryFrom<u8> for Venue {
    type Error = Error;
    fn try_from(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Venue::Pump),
            1 => Ok(Venue::Meteora),
            _ => err!(StacksError::WrongVenue),
        }
    }
}

#[repr(u8)]
pub enum Status {
    Setup = 0,
    Open = 1,
    SoldOut = 2,
}

#[event]
pub struct LaunchCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub venue: u8,
    pub mode: u8,
    pub prebuy: u8,
}

#[event]
pub struct AuctionOpened {
    pub mint: Pubkey,
}

#[event]
pub struct StackTaken {
    pub mint: Pubkey,
    pub index: u8,
    pub buyer: Pubkey,
    pub price: u64,
    pub protocol_fee: u64,
}

#[event]
pub struct FeesClaimed {
    pub mint: Pubkey,
    pub index: u8,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StackTransferred {
    pub mint: Pubkey,
    pub index: u8,
    pub from: Pubkey,
    pub to: Pubkey,
}

#[event]
pub struct FeesHarvested {
    pub mint: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum StacksError {
    #[msg("Protocol fee is above the 10% cap")]
    FeeTooHigh,
    #[msg("Unknown venue")]
    WrongVenue,
    #[msg("Unknown auction mode")]
    WrongMode,
    #[msg("At most 5 Slices can be pre-bought")]
    TooManyPrebuys,
    #[msg("Venue account does not match this coin")]
    WrongVenueAccount,
    #[msg("Meteora pool does not use the Slice config")]
    WrongMeteoraConfig,
    #[msg("Only the coin's creator can register it")]
    NotCoinCreator,
    #[msg("Expected exactly ten Slice vaults")]
    WrongVaultCount,
    #[msg("Slice vault address is wrong")]
    WrongVault,
    #[msg("Launch is not in setup")]
    NotInSetup,
    #[msg("Fee sharing is not active")]
    FeeSharingNotActive,
    #[msg("Fee sharing can still be changed by its admin")]
    FeeSharingNotLocked,
    #[msg("Fee sharing does not pay the ten Slice vaults 10% each")]
    FeeSharingMismatch,
    #[msg("Auction is not open")]
    AuctionNotOpen,
    #[msg("Slice index must be 0-9")]
    BadIndex,
    #[msg("This Slice is already taken")]
    StackTaken,
    #[msg("Price is above your maximum")]
    PriceAboveMax,
    #[msg("You do not own this Slice")]
    NotStackOwner,
    #[msg("Nothing to claim yet")]
    NothingToClaim,
    #[msg("New owner is not valid")]
    BadNewOwner,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Account data could not be read")]
    BadAccountData,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// (start, floor, drop per 15 s) in lamports.
pub fn mode_prices(mode: u8) -> Result<(u64, u64, u64)> {
    match mode {
        // Degen: 1.5 -> 0.5 SOL, -0.125 SOL / 15 s
        0 => Ok((1_500_000_000, 500_000_000, 125_000_000)),
        // Builder: 4 -> 1 SOL, -0.2 SOL / 15 s
        1 => Ok((4_000_000_000, 1_000_000_000, 200_000_000)),
        _ => err!(StacksError::WrongMode),
    }
}

pub fn current_price(start: u64, floor: u64, drop: u64, clock_start: i64, now: i64) -> u64 {
    let elapsed = now.saturating_sub(clock_start).max(0);
    let steps = (elapsed / STEP_SECONDS) as u64;
    let cut = drop.saturating_mul(steps);
    start.saturating_sub(cut).max(floor)
}

pub fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(StacksError::MathOverflow)?
        / 10_000u128;
    Ok(v as u64)
}

pub fn vault_address(mint: &Pubkey, index: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", mint.as_ref(), &[index]], &crate::ID)
}

pub fn fee_auth_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"fee_auth", mint.as_ref()], &crate::ID)
}

fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&data[offset..offset + 32]);
    Pubkey::new_from_array(b)
}

fn ix_disc(name: &str) -> [u8; 8] {
    let mut d = [0u8; 8];
    d.copy_from_slice(&hash(format!("global:{name}").as_bytes()).to_bytes()[..8]);
    d
}

fn account_disc(name: &str) -> [u8; 8] {
    let mut d = [0u8; 8];
    d.copy_from_slice(&hash(format!("account:{name}").as_bytes()).to_bytes()[..8]);
    d
}

pub struct SharingConfigView {
    pub mint: Pubkey,
    pub active: bool,
    pub admin_revoked: bool,
    pub shareholders: Vec<(Pubkey, u16)>,
}

/// Borsh layout: disc(8) bump(1) version(1) status(1) mint(32) admin(32)
/// admin_revoked(1) vec_len(u32) [address(32) share_bps(u16)]*
pub fn parse_sharing_config(data: &[u8]) -> Result<SharingConfigView> {
    require!(data.len() >= 80, StacksError::BadAccountData);
    require!(
        data[..8] == PUMP_SHARING_CONFIG_DISC,
        StacksError::BadAccountData
    );
    let status = data[10];
    let mint = read_pubkey(data, 11);
    let admin_revoked = data[75] != 0;
    let len = u32::from_le_bytes([data[76], data[77], data[78], data[79]]) as usize;
    require!(len <= 16, StacksError::BadAccountData);
    require!(data.len() >= 80 + len * 34, StacksError::BadAccountData);
    let mut shareholders = Vec::with_capacity(len);
    for k in 0..len {
        let o = 80 + k * 34;
        let addr = read_pubkey(data, o);
        let bps = u16::from_le_bytes([data[o + 32], data[o + 33]]);
        shareholders.push((addr, bps));
    }
    Ok(SharingConfigView {
        mint,
        active: status == 1,
        admin_revoked,
        shareholders,
    })
}

fn pay<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system.clone(),
            system_program::Transfer {
                from: from.clone(),
                to: to.clone(),
            },
        ),
        amount,
    )
}

fn pay_signed<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    system_program::transfer(
        CpiContext::new_with_signer(
            system.clone(),
            system_program::Transfer {
                from: from.clone(),
                to: to.clone(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn degen_price_steps_down_to_floor() {
        let (s, f, d) = mode_prices(0).unwrap();
        assert_eq!(current_price(s, f, d, 0, 0), 1_500_000_000);
        assert_eq!(current_price(s, f, d, 0, 14), 1_500_000_000);
        assert_eq!(current_price(s, f, d, 0, 15), 1_375_000_000);
        assert_eq!(current_price(s, f, d, 0, 45), 1_125_000_000);
        assert_eq!(current_price(s, f, d, 0, 120), 500_000_000);
        assert_eq!(current_price(s, f, d, 0, 10_000_000), 500_000_000);
    }

    #[test]
    fn builder_price_reaches_floor_at_225s() {
        let (s, f, d) = mode_prices(1).unwrap();
        assert_eq!(current_price(s, f, d, 100, 100 + 210), 1_200_000_000);
        assert_eq!(current_price(s, f, d, 100, 100 + 225), 1_000_000_000);
    }

    #[test]
    fn clock_in_future_is_start_price() {
        let (s, f, d) = mode_prices(0).unwrap();
        assert_eq!(current_price(s, f, d, 1_000, 900), s);
    }

    #[test]
    fn fee_math() {
        assert_eq!(bps_of(1_500_000_000, 200).unwrap(), 30_000_000);
        assert_eq!(bps_of(0, 200).unwrap(), 0);
        assert_eq!(bps_of(u64::MAX, 10_000).unwrap(), u64::MAX);
    }

    #[test]
    fn parses_sharing_config() {
        let mint = Pubkey::new_unique();
        let mut d = PUMP_SHARING_CONFIG_DISC.to_vec();
        d.extend_from_slice(&[255, 2, 1]);
        d.extend_from_slice(mint.as_ref());
        d.extend_from_slice(Pubkey::new_unique().as_ref());
        d.push(1);
        d.extend_from_slice(&10u32.to_le_bytes());
        for i in 0..10u8 {
            d.extend_from_slice(vault_address(&mint, i).0.as_ref());
            d.extend_from_slice(&1000u16.to_le_bytes());
        }
        let v = parse_sharing_config(&d).unwrap();
        assert!(v.active && v.admin_revoked);
        assert_eq!(v.mint, mint);
        assert_eq!(v.shareholders.len(), 10);
        assert_eq!(v.shareholders[3].0, vault_address(&mint, 3).0);
    }
}
