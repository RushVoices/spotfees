//! End-to-end tests of the compiled program in LiteSVM.
//!
//! Pump and Meteora are simulated by writing their accounts (bonding curve,
//! fee-sharing config, DBC pool) with the exact byte layouts from their
//! published IDLs/source, owned by their real program ids. Pump paying fees
//! into a Stack is simulated by crediting lamports to that Stack's vault,
//! which is what Pump's `distribute_creator_fees_v2` does.
//!
//! Run: `cargo build-sbf` then `cargo test -p stacks --test integration`.

use anchor_lang::{system_program, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    clock::Clock,
    hash::hash,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use stacks::{
    fee_auth_address, vault_address, ConfigParams, Launch, DBC_PROGRAM_ID, PUMP_FEES_PROGRAM_ID,
    PUMP_PROGRAM_ID,
};

const SOL: u64 = 1_000_000_000;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    treasury: Pubkey,
    meteora_config: Pubkey,
}

fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &stacks::ID).0
}
fn launch_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"launch", mint.as_ref()], &stacks::ID).0
}
fn vaults(mint: &Pubkey) -> Vec<AccountMeta> {
    (0..10u8)
        .map(|i| AccountMeta::new(vault_address(mint, i).0, false))
        .collect()
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/stacks.so");
    svm.add_program_from_file(stacks::ID, so)
        .expect("build first: cargo build-sbf");
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10 * SOL).unwrap();
    let treasury = Pubkey::new_unique();
    let meteora_config = Pubkey::new_unique();
    let mut env = Env {
        svm,
        admin,
        treasury,
        meteora_config,
    };

    let ix = Instruction {
        program_id: stacks::ID,
        accounts: stacks::accounts::Initialize {
            admin: env.admin.pubkey(),
            config: config_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: stacks::instruction::Initialize {
            params: ConfigParams {
                treasury,
                protocol_fee_bps: 200,
                launch_fee_lamports: 0,
                meteora_config,
            },
        }
        .data(),
    };
    let admin = env.admin.insecure_clone();
    send(&mut env.svm, &[ix], &admin, &[]).expect("initialize");
    env
}

fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    extra: &[&Keypair],
) -> Result<(), String> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&payer.pubkey()),
        &signers,
        svm.latest_blockhash(),
    );
    let r = svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.meta.logs));
    svm.expire_blockhash();
    r
}

fn user(svm: &mut LiteSVM, sol: u64) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
    k
}

fn lamports(svm: &LiteSVM, k: &Pubkey) -> u64 {
    svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
}

fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp += secs;
    svm.set_sysvar(&c);
}

fn read_launch(svm: &LiteSVM, mint: &Pubkey) -> Launch {
    use anchor_lang::AccountDeserialize;
    let a = svm.get_account(&launch_pda(mint)).expect("launch exists");
    Launch::try_deserialize(&mut a.data.as_slice()).unwrap()
}

// --- Simulated Pump / Meteora accounts ------------------------------------

fn put_pump_bonding_curve(svm: &mut LiteSVM, mint: &Pubkey, creator: &Pubkey) -> Pubkey {
    let (bc, _) =
        Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM_ID);
    let mut data = vec![23u8, 183, 248, 55, 96, 216, 172, 96];
    data.extend_from_slice(&[0u8; 40]); // reserves + supply
    data.push(0); // complete
    data.extend_from_slice(creator.as_ref());
    data.extend_from_slice(&[0u8; 120]);
    svm.set_account(
        bc,
        Account {
            lamports: SOL,
            data,
            owner: PUMP_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    bc
}

fn put_sharing_config(
    svm: &mut LiteSVM,
    mint: &Pubkey,
    revoked: bool,
    holders: &[(Pubkey, u16)],
) -> Pubkey {
    let (sc, _) =
        Pubkey::find_program_address(&[b"sharing-config", mint.as_ref()], &PUMP_FEES_PROGRAM_ID);
    let mut data = vec![216u8, 74, 9, 0, 56, 140, 93, 75];
    data.extend_from_slice(&[254, 2, 1]); // bump, version, status=Active
    data.extend_from_slice(mint.as_ref());
    data.extend_from_slice(Pubkey::new_unique().as_ref()); // admin
    data.push(revoked as u8);
    data.extend_from_slice(&(holders.len() as u32).to_le_bytes());
    for (a, bps) in holders {
        data.extend_from_slice(a.as_ref());
        data.extend_from_slice(&bps.to_le_bytes());
    }
    data.resize(1024, 0);
    svm.set_account(
        sc,
        Account {
            lamports: SOL,
            data,
            owner: PUMP_FEES_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    sc
}

fn put_dbc_pool(
    svm: &mut LiteSVM,
    pool: &Pubkey,
    config: &Pubkey,
    creator: &Pubkey,
    mint: &Pubkey,
) {
    let mut data = hash(b"account:VirtualPool").to_bytes()[..8].to_vec();
    data.extend_from_slice(&[0u8; 64]);
    data.extend_from_slice(config.as_ref());
    data.extend_from_slice(creator.as_ref());
    data.extend_from_slice(mint.as_ref());
    data.resize(8 + 416, 0);
    svm.set_account(
        *pool,
        Account {
            lamports: SOL,
            data,
            owner: DBC_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

// --- Instruction builders --------------------------------------------------

fn ix_create_launch(
    env: &Env,
    creator: &Pubkey,
    mint: &Pubkey,
    venue_account: &Pubkey,
    venue: u8,
    mode: u8,
    prebuy: u8,
) -> Instruction {
    let mut accounts = stacks::accounts::CreateLaunch {
        creator: *creator,
        config: config_pda(),
        treasury: env.treasury,
        mint: *mint,
        venue_account: *venue_account,
        launch: launch_pda(mint),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(vaults(mint));
    Instruction {
        program_id: stacks::ID,
        accounts,
        data: stacks::instruction::CreateLaunch {
            venue,
            mode,
            prebuy,
        }
        .data(),
    }
}

fn ix_open_pump(mint: &Pubkey, sc: &Pubkey) -> Instruction {
    Instruction {
        program_id: stacks::ID,
        accounts: stacks::accounts::OpenAuctionPump {
            launch: launch_pda(mint),
            sharing_config: *sc,
        }
        .to_account_metas(None),
        data: stacks::instruction::OpenAuctionPump {}.data(),
    }
}

fn ix_take(
    env: &Env,
    buyer: &Pubkey,
    creator: &Pubkey,
    mint: &Pubkey,
    index: u8,
    max_price: u64,
) -> Instruction {
    Instruction {
        program_id: stacks::ID,
        accounts: stacks::accounts::TakeStack {
            buyer: *buyer,
            config: config_pda(),
            launch: launch_pda(mint),
            creator: *creator,
            treasury: env.treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: stacks::instruction::TakeStack { index, max_price }.data(),
    }
}

fn ix_claim(owner: &Pubkey, mint: &Pubkey, index: u8) -> Instruction {
    Instruction {
        program_id: stacks::ID,
        accounts: stacks::accounts::Claim {
            owner: *owner,
            launch: launch_pda(mint),
            vault: vault_address(mint, index).0,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: stacks::instruction::Claim { index }.data(),
    }
}

/// A Pump launch that is created and opened, with 3 pre-bought Stacks.
fn open_pump_launch(env: &mut Env) -> (Keypair, Pubkey) {
    let creator = user(&mut env.svm, 20);
    let mint = Pubkey::new_unique();
    let bc = put_pump_bonding_curve(&mut env.svm, &mint, &creator.pubkey());
    let ix = ix_create_launch(env, &creator.pubkey(), &mint, &bc, 0, 0, 3);
    send(&mut env.svm, &[ix], &creator, &[]).expect("create_launch");
    let holders: Vec<(Pubkey, u16)> = (0..10u8)
        .map(|i| (vault_address(&mint, i).0, 1000))
        .collect();
    let sc = put_sharing_config(&mut env.svm, &mint, true, &holders);
    send(&mut env.svm, &[ix_open_pump(&mint, &sc)], &creator, &[]).expect("open");
    (creator, mint)
}

// --- Tests -----------------------------------------------------------------

#[test]
fn pump_launch_records_prebuys_funds_vaults_and_charges_fee() {
    let mut env = setup();
    let creator = user(&mut env.svm, 20);
    let mint = Pubkey::new_unique();
    let bc = put_pump_bonding_curve(&mut env.svm, &mint, &creator.pubkey());
    let t0 = lamports(&env.svm, &env.treasury);
    let ix = ix_create_launch(&env, &creator.pubkey(), &mint, &bc, 0, 0, 3);
    send(&mut env.svm, &[ix], &creator, &[]).expect("create_launch");

    let l = read_launch(&env.svm, &mint);
    assert_eq!(l.sold, 3);
    assert_eq!(l.status, 0, "setup until fee sharing is verified");
    assert_eq!(&l.owners[..3], &[creator.pubkey(); 3]);
    assert_eq!(l.owners[3], Pubkey::default());
    // 2% of 3 x 0.5 SOL floor
    assert_eq!(lamports(&env.svm, &env.treasury) - t0, 30_000_000);
    let rent_min = env.svm.minimum_balance_for_rent_exemption(0);
    for i in 0..10u8 {
        assert_eq!(lamports(&env.svm, &vault_address(&mint, i).0), rent_min);
    }
}

#[test]
fn only_the_coin_creator_can_register_it() {
    let mut env = setup();
    let creator = user(&mut env.svm, 5);
    let attacker = user(&mut env.svm, 5);
    let mint = Pubkey::new_unique();
    let bc = put_pump_bonding_curve(&mut env.svm, &mint, &creator.pubkey());
    let ix = ix_create_launch(&env, &attacker.pubkey(), &mint, &bc, 0, 0, 0);
    let err = send(&mut env.svm, &[ix], &attacker, &[]).unwrap_err();
    assert!(err.contains("NotCoinCreator"), "{err}");
}

#[test]
fn auction_opens_only_when_pump_fee_sharing_is_locked_to_the_vaults() {
    let mut env = setup();
    let creator = user(&mut env.svm, 20);
    let mint = Pubkey::new_unique();
    let bc = put_pump_bonding_curve(&mut env.svm, &mint, &creator.pubkey());
    let ix = ix_create_launch(&env, &creator.pubkey(), &mint, &bc, 0, 0, 0);
    send(&mut env.svm, &[ix], &creator, &[]).unwrap();

    let good: Vec<(Pubkey, u16)> = (0..10u8)
        .map(|i| (vault_address(&mint, i).0, 1000))
        .collect();

    // Admin not revoked: creator could still change the shares later.
    let sc = put_sharing_config(&mut env.svm, &mint, false, &good);
    let err = send(&mut env.svm, &[ix_open_pump(&mint, &sc)], &creator, &[]).unwrap_err();
    assert!(err.contains("FeeSharingNotLocked"), "{err}");

    // One share redirected to the creator.
    let mut bad = good.clone();
    bad[9] = (creator.pubkey(), 1000);
    put_sharing_config(&mut env.svm, &mint, true, &bad);
    let err = send(&mut env.svm, &[ix_open_pump(&mint, &sc)], &creator, &[]).unwrap_err();
    assert!(err.contains("FeeSharingMismatch"), "{err}");

    // Uneven split.
    let mut uneven = good.clone();
    uneven[0].1 = 1500;
    uneven[1].1 = 500;
    put_sharing_config(&mut env.svm, &mint, true, &uneven);
    let err = send(&mut env.svm, &[ix_open_pump(&mint, &sc)], &creator, &[]).unwrap_err();
    assert!(err.contains("FeeSharingMismatch"), "{err}");

    put_sharing_config(&mut env.svm, &mint, true, &good);
    send(&mut env.svm, &[ix_open_pump(&mint, &sc)], &creator, &[]).expect("open");
    assert_eq!(read_launch(&env.svm, &mint).status, 1);
}

#[test]
fn take_pays_creator_minus_two_percent_and_price_steps_down() {
    let mut env = setup();
    let (creator, mint) = open_pump_launch(&mut env);
    let buyer = user(&mut env.svm, 10);

    let c0 = lamports(&env.svm, &creator.pubkey());
    let t0 = lamports(&env.svm, &env.treasury);
    let ix = ix_take(
        &env,
        &buyer.pubkey(),
        &creator.pubkey(),
        &mint,
        3,
        1_500_000_000,
    );
    send(&mut env.svm, &[ix], &buyer, &[]).expect("take at start price");
    assert_eq!(lamports(&env.svm, &creator.pubkey()) - c0, 1_470_000_000);
    assert_eq!(lamports(&env.svm, &env.treasury) - t0, 30_000_000);
    let l = read_launch(&env.svm, &mint);
    assert_eq!(l.owners[3], buyer.pubkey());
    assert_eq!(l.paid[3], 1_500_000_000);
    assert_eq!(l.sold, 4);

    // Same Stack again.
    let ix = ix_take(&env, &buyer.pubkey(), &creator.pubkey(), &mint, 3, 2 * SOL);
    let err = send(&mut env.svm, &[ix], &buyer, &[]).unwrap_err();
    assert!(err.contains("StackTaken"), "{err}");

    // 45 s later the price is 1.125 SOL; a 1.0 SOL limit is refused.
    warp(&mut env.svm, 45);
    let ix = ix_take(&env, &buyer.pubkey(), &creator.pubkey(), &mint, 4, SOL);
    let err = send(&mut env.svm, &[ix], &buyer, &[]).unwrap_err();
    assert!(err.contains("PriceAboveMax"), "{err}");
    let ix = ix_take(
        &env,
        &buyer.pubkey(),
        &creator.pubkey(),
        &mint,
        4,
        1_125_000_000,
    );
    send(&mut env.svm, &[ix], &buyer, &[]).expect("take at 1.125");
    assert_eq!(read_launch(&env.svm, &mint).paid[4], 1_125_000_000);

    // The clock restarted, so the next Stack is back at the start price.
    let ix = ix_take(
        &env,
        &buyer.pubkey(),
        &creator.pubkey(),
        &mint,
        5,
        1_125_000_000,
    );
    let err = send(&mut env.svm, &[ix], &buyer, &[]).unwrap_err();
    assert!(err.contains("PriceAboveMax"), "{err}");

    // Long wait: price never goes below the floor.
    warp(&mut env.svm, 10_000);
    let ix = ix_take(
        &env,
        &buyer.pubkey(),
        &creator.pubkey(),
        &mint,
        5,
        500_000_000,
    );
    send(&mut env.svm, &[ix], &buyer, &[]).expect("take at floor");
}

#[test]
fn creator_cannot_be_redirected_and_auction_must_be_open() {
    let mut env = setup();
    let creator = user(&mut env.svm, 20);
    let mint = Pubkey::new_unique();
    let bc = put_pump_bonding_curve(&mut env.svm, &mint, &creator.pubkey());
    send(
        &mut env.svm,
        &[ix_create_launch(
            &env,
            &creator.pubkey(),
            &mint,
            &bc,
            0,
            0,
            0,
        )],
        &creator,
        &[],
    )
    .unwrap();
    let buyer = user(&mut env.svm, 10);

    let ix = ix_take(&env, &buyer.pubkey(), &creator.pubkey(), &mint, 0, 2 * SOL);
    let err = send(&mut env.svm, &[ix], &buyer, &[]).unwrap_err();
    assert!(err.contains("AuctionNotOpen"), "{err}");

    let good: Vec<(Pubkey, u16)> = (0..10u8)
        .map(|i| (vault_address(&mint, i).0, 1000))
        .collect();
    let sc = put_sharing_config(&mut env.svm, &mint, true, &good);
    send(&mut env.svm, &[ix_open_pump(&mint, &sc)], &creator, &[]).unwrap();

    let thief = Pubkey::new_unique();
    let ix = ix_take(&env, &buyer.pubkey(), &thief, &mint, 0, 2 * SOL);
    assert!(
        send(&mut env.svm, &[ix], &buyer, &[]).is_err(),
        "proceeds must go to the creator"
    );
}

#[test]
fn holders_claim_fees_paid_into_their_vault() {
    let mut env = setup();
    let (creator, mint) = open_pump_launch(&mut env);
    let buyer = user(&mut env.svm, 10);
    send(
        &mut env.svm,
        &[ix_take(
            &env,
            &buyer.pubkey(),
            &creator.pubkey(),
            &mint,
            7,
            2 * SOL,
        )],
        &buyer,
        &[],
    )
    .unwrap();

    // Pump's distribute_creator_fees_v2 pays each shareholder vault.
    let (v7, _) = vault_address(&mint, 7);
    let mut acc = env.svm.get_account(&v7).unwrap();
    acc.lamports += 250_000_000;
    env.svm.set_account(v7, acc).unwrap();

    let stranger = user(&mut env.svm, 1);
    let err = send(
        &mut env.svm,
        &[ix_claim(&stranger.pubkey(), &mint, 7)],
        &stranger,
        &[],
    )
    .unwrap_err();
    assert!(err.contains("NotStackOwner"), "{err}");

    let b0 = lamports(&env.svm, &buyer.pubkey());
    send(
        &mut env.svm,
        &[ix_claim(&buyer.pubkey(), &mint, 7)],
        &buyer,
        &[],
    )
    .expect("claim");
    // Fee payer is the buyer, so subtract the 5,000-lamport signature fee.
    assert_eq!(
        lamports(&env.svm, &buyer.pubkey()) + 5_000 - b0,
        250_000_000
    );
    assert_eq!(
        lamports(&env.svm, &v7),
        env.svm.minimum_balance_for_rent_exemption(0)
    );

    let err = send(
        &mut env.svm,
        &[ix_claim(&buyer.pubkey(), &mint, 7)],
        &buyer,
        &[],
    )
    .unwrap_err();
    assert!(err.contains("NothingToClaim"), "{err}");

    // Creator's pre-bought Stack 0 earns too.
    let (v0, _) = vault_address(&mint, 0);
    let mut acc = env.svm.get_account(&v0).unwrap();
    acc.lamports += 100_000_000;
    env.svm.set_account(v0, acc).unwrap();
    send(
        &mut env.svm,
        &[ix_claim(&creator.pubkey(), &mint, 0)],
        &creator,
        &[],
    )
    .expect("creator claims");
}

#[test]
fn stacks_can_be_transferred() {
    let mut env = setup();
    let (creator, mint) = open_pump_launch(&mut env);
    let buyer = user(&mut env.svm, 10);
    send(
        &mut env.svm,
        &[ix_take(
            &env,
            &buyer.pubkey(),
            &creator.pubkey(),
            &mint,
            9,
            2 * SOL,
        )],
        &buyer,
        &[],
    )
    .unwrap();

    let friend = user(&mut env.svm, 1);
    let ix = Instruction {
        program_id: stacks::ID,
        accounts: stacks::accounts::TransferStack {
            owner: buyer.pubkey(),
            launch: launch_pda(&mint),
        }
        .to_account_metas(None),
        data: stacks::instruction::TransferStack {
            index: 9,
            new_owner: friend.pubkey(),
        }
        .data(),
    };
    send(&mut env.svm, &[ix], &buyer, &[]).expect("transfer");
    assert_eq!(read_launch(&env.svm, &mint).owners[9], friend.pubkey());

    let (v9, _) = vault_address(&mint, 9);
    let mut acc = env.svm.get_account(&v9).unwrap();
    acc.lamports += 10_000_000;
    env.svm.set_account(v9, acc).unwrap();
    let err = send(
        &mut env.svm,
        &[ix_claim(&buyer.pubkey(), &mint, 9)],
        &buyer,
        &[],
    )
    .unwrap_err();
    assert!(err.contains("NotStackOwner"), "{err}");
    send(
        &mut env.svm,
        &[ix_claim(&friend.pubkey(), &mint, 9)],
        &friend,
        &[],
    )
    .expect("new owner claims");
}

#[test]
fn launch_sells_out_after_ten_stacks() {
    let mut env = setup();
    let (creator, mint) = open_pump_launch(&mut env);
    let buyer = user(&mut env.svm, 20);
    for i in 3..10u8 {
        send(
            &mut env.svm,
            &[ix_take(
                &env,
                &buyer.pubkey(),
                &creator.pubkey(),
                &mint,
                i,
                2 * SOL,
            )],
            &buyer,
            &[],
        )
        .expect("take");
    }
    let l = read_launch(&env.svm, &mint);
    assert_eq!(l.sold, 10);
    assert_eq!(l.status, 2);
}

#[test]
fn meteora_launch_opens_only_after_creator_moves_to_fee_authority() {
    let mut env = setup();
    let creator = user(&mut env.svm, 20);
    let mint = Pubkey::new_unique();
    let pool = Pubkey::new_unique();

    // Pool on someone else's config is refused.
    let other_config = Pubkey::new_unique();
    put_dbc_pool(&mut env.svm, &pool, &other_config, &creator.pubkey(), &mint);
    let ix = ix_create_launch(&env, &creator.pubkey(), &mint, &pool, 1, 1, 2);
    let err = send(&mut env.svm, &[ix.clone()], &creator, &[]).unwrap_err();
    assert!(err.contains("WrongMeteoraConfig"), "{err}");

    put_dbc_pool(
        &mut env.svm,
        &pool,
        &env.meteora_config,
        &creator.pubkey(),
        &mint,
    );
    send(&mut env.svm, &[ix], &creator, &[]).expect("create meteora launch");
    let l = read_launch(&env.svm, &mint);
    assert_eq!((l.venue, l.start_price, l.floor_price), (1, 4 * SOL, SOL));

    let open = Instruction {
        program_id: stacks::ID,
        accounts: stacks::accounts::OpenAuctionMeteora {
            launch: launch_pda(&mint),
            pool,
        }
        .to_account_metas(None),
        data: stacks::instruction::OpenAuctionMeteora {}.data(),
    };
    let err = send(&mut env.svm, &[open.clone()], &creator, &[]).unwrap_err();
    assert!(err.contains("FeeSharingMismatch"), "{err}");

    // Meteora's transfer_pool_creator to the program's fee authority.
    put_dbc_pool(
        &mut env.svm,
        &pool,
        &env.meteora_config,
        &fee_auth_address(&mint).0,
        &mint,
    );
    send(&mut env.svm, &[open], &creator, &[]).expect("open");
    assert_eq!(read_launch(&env.svm, &mint).status, 1);
}

#[test]
fn only_admin_updates_config_and_fee_is_capped() {
    let mut env = setup();
    let other = user(&mut env.svm, 1);
    let mk = |admin: Pubkey, bps: u16| Instruction {
        program_id: stacks::ID,
        accounts: stacks::accounts::UpdateConfig {
            admin,
            config: config_pda(),
        }
        .to_account_metas(None),
        data: stacks::instruction::UpdateConfig {
            params: ConfigParams {
                treasury: Pubkey::new_unique(),
                protocol_fee_bps: bps,
                launch_fee_lamports: 0,
                meteora_config: Pubkey::new_unique(),
            },
        }
        .data(),
    };
    assert!(send(&mut env.svm, &[mk(other.pubkey(), 200)], &other, &[]).is_err());
    let admin = env.admin.insecure_clone();
    let err = send(&mut env.svm, &[mk(admin.pubkey(), 1_001)], &admin, &[]).unwrap_err();
    assert!(err.contains("FeeTooHigh"), "{err}");
    send(&mut env.svm, &[mk(admin.pubkey(), 300)], &admin, &[]).expect("admin update");
}
