//! Fixed shares in the fees of one permanently locked liquidity position.
//! Core asset ownership supplies claim authority. Paid balances follow the asset.
//! Account and instruction layouts are also defined in feeVaultClient.js.
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

const CORE: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const DAMM: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const LOCK: Pubkey = pubkey!("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
const DLOCK: Pubkey = pubkey!("DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC");
const CLMM: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const DCLMM: Pubkey = pubkey!("devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH");
// Header: magic, creator, seed, collection, venue, pool, source position/lock,
// native NFT mint, fee mints, token programs, count, registered, total weight,
// registered weight, active, total paid A/B. Entries: asset, weight, paid A/B.
pub const HEADER: usize = 366;
pub const ENTRY: usize = 56;
const MAGIC: &[u8; 8] = b"TFEEV002";
const CLAIM_DAMM: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
const CLAIM_LOCK: [u8; 8] = [16, 72, 250, 198, 14, 162, 212, 19];

fn fail() -> ProgramError {
    ProgramError::InvalidAccountData
}
fn require(ok: bool) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(fail())
    }
}
fn key(data: &[u8], offset: usize) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::new_from_array(
        data.get(offset..offset + 32)
            .ok_or_else(fail)?
            .try_into()
            .map_err(|_| fail())?,
    ))
}
fn num(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        data.get(offset..offset + 8)
            .ok_or_else(fail)?
            .try_into()
            .map_err(|_| fail())?,
    ))
}
fn count(data: &[u8], offset: usize) -> Result<usize, ProgramError> {
    Ok(u16::from_le_bytes(
        data.get(offset..offset + 2)
            .ok_or_else(fail)?
            .try_into()
            .map_err(|_| fail())?,
    ) as usize)
}
fn put(data: &mut [u8], offset: usize, n: u64) {
    data[offset..offset + 8].copy_from_slice(&n.to_le_bytes());
}
fn add(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_add(b).ok_or(ProgramError::ArithmeticOverflow)
}
fn token_program(id: &Pubkey) -> bool {
    *id == TOKEN || *id == TOKEN22
}
// Core base and registry layouts are Borsh. Check raw plugin types because
// clients may hide unknown plugins. Account ownership is checked by callers.
fn core_controls(d: &[u8], collection: bool) -> ProgramResult {
    fn take(d: &[u8], at: &mut usize, n: usize) -> Result<usize, ProgramError> {
        let start = *at;
        *at = at.checked_add(n).ok_or_else(fail)?;
        require(*at <= d.len())?;
        Ok(start)
    }
    fn byte(d: &[u8], at: &mut usize) -> Result<u8, ProgramError> {
        Ok(d[take(d, at, 1)?])
    }
    fn uint(d: &[u8], at: &mut usize) -> Result<usize, ProgramError> {
        let start = take(d, at, 4)?;
        Ok(u32::from_le_bytes(d[start..start + 4].try_into().map_err(|_| fail())?) as usize)
    }
    let mut at = 0;
    require(byte(d, &mut at)? == if collection { 5 } else { 1 })?;
    take(d, &mut at, 32)?;
    if !collection {
        let authority = byte(d, &mut at)?;
        require(authority <= 2)?;
        if authority > 0 {
            take(d, &mut at, 32)?;
        }
    }
    for _ in 0..2 {
        let len = uint(d, &mut at)?;
        let start = take(d, &mut at, len)?;
        require(std::str::from_utf8(&d[start..at]).is_ok())?;
    }
    if collection {
        take(d, &mut at, 8)?;
    } else {
        let seq = byte(d, &mut at)?;
        require(seq <= 1)?;
        if seq == 1 {
            take(d, &mut at, 8)?;
        }
    }
    if at == d.len() {
        return Ok(());
    }
    require(byte(d, &mut at)? == 3)?;
    let header = take(d, &mut at, 8)?;
    let registry = usize::try_from(num(d, header)?).map_err(|_| fail())?;
    let plugins_start = at;
    require(registry >= plugins_start && registry < d.len())?;
    at = registry;
    require(byte(d, &mut at)? == 4)?;
    let n = uint(d, &mut at)?;
    require(n <= (d.len() - at) / 10)?;
    let mut seen = 0u16;
    for _ in 0..n {
        let kind = byte(d, &mut at)?;
        require(matches!(kind, 0..=4 | 6 | 9..=14))?;
        let bit = 1u16 << kind;
        require(seen & bit == 0)?;
        seen |= bit;
        let authority = byte(d, &mut at)?;
        require(authority <= 3)?;
        if authority == 3 {
            take(d, &mut at, 32)?;
        }
        let pos = take(d, &mut at, 8)?;
        let offset = usize::try_from(num(d, pos)?).map_err(|_| fail())?;
        require(offset >= plugins_start && offset < registry && d[offset] == kind)?;
    }
    // External hooks and new plugin types need their own reviewed support.
    require(uint(d, &mut at)? == 0 && at == d.len())
}
fn core_collection(data: &[u8], info: &AccountInfo) -> ProgramResult {
    require(*info.owner == CORE && *info.key == key(data, 72)?)?;
    core_controls(&info.try_borrow_data()?, true)
}
fn fee_account(
    info: &AccountInfo,
    mint: &Pubkey,
    owner: &Pubkey,
    program: &Pubkey,
) -> Result<u64, ProgramError> {
    let (expected, _) =
        Pubkey::find_program_address(&[owner.as_ref(), program.as_ref(), mint.as_ref()], &ATA);
    require(*info.key == expected)?;
    token_account(info, mint, owner, program)
}
fn token_account(
    info: &AccountInfo,
    mint: &Pubkey,
    owner: &Pubkey,
    program: &Pubkey,
) -> Result<u64, ProgramError> {
    require(info.owner == program && token_program(program))?;
    let d = info.try_borrow_data()?;
    require(d.len() >= 165 && key(&d, 0)? == *mint && key(&d, 32)? == *owner && d[108] == 1)?;
    // Vault accounts use their owner alone, with no delegate or close authority.
    if !info.is_signer {
        require(d[72..76] == [0; 4] && d[129..133] == [0; 4])?;
    }
    num(&d, 64)
}
fn mint(info: &AccountInfo, program: &Pubkey) -> Result<u8, ProgramError> {
    require(info.owner == program && token_program(program))?;
    let d = info.try_borrow_data()?;
    require(d.len() >= 82 && d[45] == 1 && d[46..50] == [0; 4])?;
    // Fee mints accept standard mint data and metadata-only Token-2022 extensions.
    // Transfer fees, hooks, delegates, frozen defaults and confidential transfers
    // change the payout contract and need a separate implementation.
    if d.len() > 82 {
        require(*program == TOKEN22 && d.len() >= 166 && d[165] == 1)?;
        let mut at = 166;
        let mut seen = 0u32;
        while at < d.len() {
            if d[at..].iter().all(|b| *b == 0) {
                break;
            }
            require(at + 4 <= d.len())?;
            let kind = u16::from_le_bytes([d[at], d[at + 1]]);
            let len = u16::from_le_bytes([d[at + 2], d[at + 3]]) as usize;
            require(matches!(kind, 18 | 19))?; // MetadataPointer, TokenMetadata
            let bit = 1u32 << kind;
            require(seen & bit == 0)?;
            seen |= bit;
            at = at.checked_add(4 + len).ok_or_else(fail)?;
            require(at <= d.len())?;
        }
    }
    Ok(d[44])
}
fn vault<'a>(id: &Pubkey, info: &'a AccountInfo) -> Result<Vec<u8>, ProgramError> {
    require(info.owner == id && info.is_writable)?;
    let data = info.try_borrow_data()?.to_vec();
    require(data.len() >= HEADER && &data[..8] == MAGIC)?;
    let creator = key(&data, 8)?;
    let (expected, _) =
        Pubkey::find_program_address(&[b"fee-vault", creator.as_ref(), &data[40..72]], id);
    require(expected == *info.key && data.len() == HEADER + count(&data, 329)? * ENTRY)?;
    Ok(data)
}
fn creator(data: &[u8], signer: &AccountInfo) -> ProgramResult {
    require(signer.is_signer && key(data, 8)? == *signer.key)
}
fn native_holding(
    data: &[u8],
    holder: &AccountInfo,
    mint_info: &AccountInfo,
    vault_key: &Pubkey,
) -> ProgramResult {
    require(key(data, 169)? == *mint_info.key && token_program(mint_info.owner))?;
    let m = mint_info.try_borrow_data()?;
    require(m.len() >= 82 && m[44] == 0 && m[45] == 1 && m[46..50] == [0; 4] && num(&m, 36)? == 1)?;
    require(token_account(holder, mint_info.key, vault_key, mint_info.owner)? == 1)
}
fn locked_source(data: &[u8], position: &AccountInfo, pool: &AccountInfo) -> ProgramResult {
    require(key(data, 137)? == *position.key && key(data, 105)? == *pool.key)?;
    let p = position.try_borrow_data()?;
    let q = pool.try_borrow_data()?;
    let nft = key(data, 169)?;
    match data[104] {
        0 => {
            require(
                *position.owner == DAMM && *pool.owner == DAMM && p.len() >= 200 && q.len() >= 484,
            )?;
            require(
                p[..8] == [170, 188, 143, 228, 122, 64, 247, 208]
                    && q[..8] == [241, 154, 109, 4, 17, 177, 109, 188],
            )?;
            let (expected, _) = Pubkey::find_program_address(&[b"position", nft.as_ref()], &DAMM);
            require(*position.key == expected)?;
            require(key(&p, 8)? == *pool.key && key(&p, 40)? == nft)?;
            require(p[152..184].iter().all(|x| *x == 0) && p[184..200].iter().any(|x| *x != 0))?;
            for n in 0..2 {
                require(key(&q, 168 + n * 32)? == key(data, 201 + n * 32)?)?;
                let flag = q[482 + n];
                require(
                    flag <= 1
                        && key(data, 265 + n * 32)? == if flag == 0 { TOKEN } else { TOKEN22 },
                )?;
            }
        }
        1 | 2 => {
            let lock_program = if data[104] == 1 { LOCK } else { DLOCK };
            let pool_program = if data[104] == 1 { CLMM } else { DCLMM };
            require(
                *position.owner == lock_program
                    && p.len() == 241
                    && *pool.owner == pool_program
                    && q.len() >= 137,
            )?;
            require(
                p[..8] == [52, 23, 5, 7, 170, 90, 108, 213]
                    && q[..8] == [247, 237, 227, 245, 215, 195, 222, 70],
            )?;
            require(key(&p, 41)? == *pool.key && key(&p, 137)? == nft)?;
            for n in 0..2 {
                require(key(&q, 73 + n * 32)? == key(data, 201 + n * 32)?)?;
            }
            let (expected, _) =
                Pubkey::find_program_address(&[b"locked_position", nft.as_ref()], &lock_program);
            require(expected == *position.key)?;
        }
        _ => return Err(fail()),
    }
    Ok(())
}

/// Integer entitlement uses lifetime receipts, so rounding carries into later claims.
pub fn entitlement(received: u64, weight: u64, total: u64, paid: u64) -> Result<u64, ProgramError> {
    require(total > 0 && weight > 0 && weight <= total)?;
    let earned = (received as u128 * weight as u128 / total as u128) as u64;
    earned.checked_sub(paid).ok_or_else(fail)
}

pub fn process_instruction(id: &Pubkey, accounts: &[AccountInfo], input: &[u8]) -> ProgramResult {
    let op = *input.first().ok_or(ProgramError::InvalidInstructionData)?;
    match op {
        0 => initialize(id, accounts, input),
        1 => register(id, accounts, input),
        2 => activate(id, accounts, input),
        3 => harvest(id, accounts, input),
        4 => claim(id, accounts, input),
        5 => recover(id, accounts, input),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
fn recover(id: &Pubkey, a: &[AccountInfo], i: &[u8]) -> ProgramResult {
    require(a.len() == 6 && i.len() == 1)?;
    let d = vault(id, &a[1])?;
    creator(&d, &a[0])?;
    require(d[349] == 0)?;
    native_holding(&d, &a[3], &a[2], a[1].key)?;
    require(a[5].key == a[2].owner && a[5].executable)?;
    token_account(&a[4], a[2].key, a[0].key, a[5].key)?;
    let creator = key(&d, 8)?;
    let (_, bump) = Pubkey::find_program_address(&[b"fee-vault", creator.as_ref(), &d[40..72]], id);
    let mut payload = vec![12];
    payload.extend_from_slice(&1u64.to_le_bytes());
    payload.push(0);
    let ix = Instruction {
        program_id: *a[5].key,
        accounts: vec![
            AccountMeta::new(*a[3].key, false),
            AccountMeta::new_readonly(*a[2].key, false),
            AccountMeta::new(*a[4].key, false),
            AccountMeta::new_readonly(*a[1].key, true),
        ],
        data: payload,
    };
    invoke_signed(
        &ix,
        &[
            a[3].clone(),
            a[2].clone(),
            a[4].clone(),
            a[1].clone(),
            a[5].clone(),
        ],
        &[&[b"fee-vault", creator.as_ref(), &d[40..72], &[bump]]],
    )
}
fn initialize(id: &Pubkey, a: &[AccountInfo], i: &[u8]) -> ProgramResult {
    require(a.len() == 3 && i.len() == 300)?;
    let payer = &a[0];
    let v = &a[1];
    require(
        payer.is_signer && payer.is_writable && v.is_writable && *a[2].key == system_program::ID,
    )?;
    let n = count(i, 33)?;
    let total = num(i, 35)?;
    require(n > 0 && n <= 128 && total > 0 && i[75] <= 2)?;
    require(
        key(i, 204)? != key(i, 236)?
            && key(i, 140)? != key(i, 204)?
            && key(i, 140)? != key(i, 236)?
            && token_program(&key(i, 268)?)
            && token_program(&key(i, 172)?),
    )?;
    let (expected, bump) =
        Pubkey::find_program_address(&[b"fee-vault", payer.key.as_ref(), &i[1..33]], id);
    require(expected == *v.key)?;
    let size = HEADER + n * ENTRY;
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            v.key,
            Rent::get()?.minimum_balance(size),
            size as u64,
            id,
        ),
        &[payer.clone(), v.clone(), a[2].clone()],
        &[&[b"fee-vault", payer.key.as_ref(), &i[1..33], &[bump]]],
    )?;
    let mut d = v.try_borrow_mut_data()?;
    d[..8].copy_from_slice(MAGIC);
    d[8..40].copy_from_slice(payer.key.as_ref());
    d[40..72].copy_from_slice(&i[1..33]);
    // Wire: collection, venue, pool, source, NFT, program A, mint A, mint B, program B.
    d[72..201].copy_from_slice(&i[43..172]);
    d[201..265].copy_from_slice(&i[204..268]);
    d[265..297].copy_from_slice(&i[172..204]);
    d[297..329].copy_from_slice(&i[268..300]);
    d[329..331].copy_from_slice(&(n as u16).to_le_bytes());
    put(&mut d, 333, total);
    Ok(())
}
fn register(id: &Pubkey, a: &[AccountInfo], i: &[u8]) -> ProgramResult {
    require(a.len() == 4 && i.len() == 11)?;
    let mut d = vault(id, &a[1])?;
    creator(&d, &a[0])?;
    require(d[349] == 0 && *a[2].owner == CORE)?;
    core_collection(&d, &a[3])?;
    let index = count(i, 1)?;
    let weight = num(i, 3)?;
    require(index < count(&d, 329)? && weight > 0)?;
    let asset = a[2].try_borrow_data()?;
    core_controls(&asset, false)?;
    require(
        asset.len() >= 66 && asset[0] == 1 && asset[33] == 2 && key(&asset, 34)? == key(&d, 72)?,
    )?;
    let off = HEADER + index * ENTRY;
    if key(&d, off)? == *a[2].key && num(&d, off + 32)? == weight {
        return Ok(());
    }
    require(d[off..off + ENTRY].iter().all(|b| *b == 0))?;
    for entry in d[HEADER..].chunks_exact(ENTRY) {
        require(key(entry, 0)? != *a[2].key)?;
    }
    let registered = count(&d, 331)? + 1;
    let registered_weight = add(num(&d, 341)?, weight)?;
    require(registered_weight <= num(&d, 333)?)?;
    d[off..off + 32].copy_from_slice(a[2].key.as_ref());
    put(&mut d, off + 32, weight);
    d[331..333].copy_from_slice(&(registered as u16).to_le_bytes());
    put(&mut d, 341, registered_weight);
    a[1].try_borrow_mut_data()?.copy_from_slice(&d);
    Ok(())
}
fn activate(id: &Pubkey, a: &[AccountInfo], i: &[u8]) -> ProgramResult {
    require(a.len() == 9 && i.len() == 1)?;
    let mut d = vault(id, &a[1])?;
    creator(&d, &a[0])?;
    core_collection(&d, &a[8])?;
    require(count(&d, 329)? == count(&d, 331)? && num(&d, 333)? == num(&d, 341)?)?;
    native_holding(&d, &a[3], &a[2], a[1].key)?;
    locked_source(&d, &a[4], &a[5])?;
    for n in 0..2 {
        require(*a[6 + n].key == key(&d, 201 + n * 32)?)?;
        mint(&a[6 + n], &key(&d, 265 + n * 32)?)?;
    }
    d[349] = 1;
    a[1].try_borrow_mut_data()?.copy_from_slice(&d);
    Ok(())
}
fn harvest(id: &Pubkey, a: &[AccountInfo], i: &[u8]) -> ProgramResult {
    require(a.len() >= 19 && i.len() == 1)?;
    let d = vault(id, &a[0])?;
    require(d[349] == 1)?;
    let c = &a[4..];
    let (target, disc, pool_index, source_index, owner_index, nft_index, out_a, out_b) =
        match d[104] {
            0 => (DAMM, CLAIM_DAMM, 1, 2, 10, 9, 3, 4),
            1 => (LOCK, CLAIM_LOCK, 7, 3, 1, 2, 13, 14),
            2 => (DLOCK, CLAIM_LOCK, 7, 3, 1, 2, 13, 14),
            _ => return Err(fail()),
        };
    require(*a[3].key == target && a[3].executable && c.len() > out_b)?;
    require(
        *c[pool_index].key == key(&d, 105)?
            && *c[source_index].key == key(&d, 137)?
            && *c[owner_index].key == *a[0].key,
    )?;
    require(*c[out_a].key == *a[1].key && *c[out_b].key == *a[2].key)?;
    for n in 0..2 {
        fee_account(
            &a[1 + n],
            &key(&d, 201 + n * 32)?,
            a[0].key,
            &key(&d, 265 + n * 32)?,
        )?;
    }
    let native_program = if d[104] == 0 { TOKEN22 } else { TOKEN };
    require(token_account(&c[nft_index], &key(&d, 169)?, a[0].key, &native_program)? == 1)?;
    // Only this fee collection instruction receives the vault signer.
    let metas = c
        .iter()
        .map(|info| AccountMeta {
            pubkey: *info.key,
            is_writable: info.is_writable,
            is_signer: *info.key == *a[0].key,
        })
        .collect();
    let ix = Instruction {
        program_id: target,
        accounts: metas,
        data: disc.to_vec(),
    };
    let creator = key(&d, 8)?;
    let (_, bump) = Pubkey::find_program_address(&[b"fee-vault", creator.as_ref(), &d[40..72]], id);
    invoke_signed(
        &ix,
        &a[3..],
        &[&[b"fee-vault", creator.as_ref(), &d[40..72], &[bump]]],
    )
}
fn claim(id: &Pubkey, a: &[AccountInfo], i: &[u8]) -> ProgramResult {
    require(a.len() == 12 && i.len() == 3)?;
    let mut d = vault(id, &a[1])?;
    require(d[349] == 1 && a[0].is_signer)?;
    core_collection(&d, &a[11])?;
    let index = count(i, 1)?;
    require(index < count(&d, 329)?)?;
    let off = HEADER + index * ENTRY;
    require(key(&d, off)? == *a[2].key && *a[2].owner == CORE)?;
    let asset = a[2].try_borrow_data()?;
    core_controls(&asset, false)?;
    require(
        asset.len() >= 66
            && asset[0] == 1
            && key(&asset, 1)? == *a[0].key
            && asset[33] == 2
            && key(&asset, 34)? == key(&d, 72)?,
    )?;
    drop(asset);
    let creator = key(&d, 8)?;
    let (_, bump) = Pubkey::find_program_address(&[b"fee-vault", creator.as_ref(), &d[40..72]], id);
    for n in 0..2 {
        let (source, destination, mint_info, program) =
            (&a[3 + n], &a[5 + n], &a[7 + n], &a[9 + n]);
        let fee_mint = key(&d, 201 + n * 32)?;
        let token_id = key(&d, 265 + n * 32)?;
        require(*mint_info.key == fee_mint && *program.key == token_id && program.executable)?;
        let decimals = mint(mint_info, &token_id)?;
        let balance = fee_account(source, &fee_mint, a[1].key, &token_id)?;
        token_account(destination, &fee_mint, a[0].key, &token_id)?;
        let total_paid = num(&d, 350 + n * 8)?;
        let paid = num(&d, off + 40 + n * 8)?;
        let amount = entitlement(
            add(balance, total_paid)?,
            num(&d, off + 32)?,
            num(&d, 333)?,
            paid,
        )?;
        if amount == 0 {
            continue;
        }
        // Save accounting before the token CPI; Solana rolls back the whole instruction on error.
        put(&mut d, off + 40 + n * 8, add(paid, amount)?);
        put(&mut d, 350 + n * 8, add(total_paid, amount)?);
        a[1].try_borrow_mut_data()?.copy_from_slice(&d);
        let mut payload = vec![12];
        payload.extend_from_slice(&amount.to_le_bytes());
        payload.push(decimals);
        let ix = Instruction {
            program_id: token_id,
            accounts: vec![
                AccountMeta::new(*source.key, false),
                AccountMeta::new_readonly(fee_mint, false),
                AccountMeta::new(*destination.key, false),
                AccountMeta::new_readonly(*a[1].key, true),
            ],
            data: payload,
        };
        invoke_signed(
            &ix,
            &[
                source.clone(),
                mint_info.clone(),
                destination.clone(),
                a[1].clone(),
                program.clone(),
            ],
            &[&[b"fee-vault", creator.as_ref(), &d[40..72], &[bump]]],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod security_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equal_shares_carry_dust() {
        assert_eq!(entitlement(107, 1, 54, 0).unwrap(), 1);
        assert_eq!(entitlement(108, 1, 54, 1).unwrap(), 1);
    }
    #[test]
    fn paid_rights_follow_asset() {
        assert_eq!(entitlement(100, 1, 2, 50).unwrap(), 0);
        assert_eq!(entitlement(140, 1, 2, 50).unwrap(), 20);
    }
    #[test]
    fn wide_integer_math() {
        assert_eq!(entitlement(u64::MAX, 1, 1, 0).unwrap(), u64::MAX);
    }
    #[test]
    fn invalid_weights_and_overpayment() {
        for args in [(1, 0, 1, 0), (1, 2, 1, 0), (1, 1, 0, 0), (1, 1, 1, 2)] {
            assert!(entitlement(args.0, args.1, args.2, args.3).is_err());
        }
    }
    #[test]
    fn conservation() {
        for income in 0..200 {
            let paid: u64 = [1, 2, 3]
                .iter()
                .map(|w| entitlement(income, *w, 6, 0).unwrap())
                .sum();
            assert!(paid <= income && income - paid < 3);
        }
    }
}
