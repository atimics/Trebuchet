use super::*;

fn core_data(collection: bool, address: Pubkey, plugin: Option<u8>) -> Vec<u8> {
    let mut d = vec![if collection { 5 } else { 1 }];
    d.extend_from_slice(Pubkey::new_unique().as_ref());
    if !collection {
        d.push(2);
        d.extend_from_slice(address.as_ref());
    }
    d.extend_from_slice(&[0; 8]); // name and URI
    if collection {
        d.extend_from_slice(&[0; 8]);
    } else {
        d.push(0);
    }
    if let Some(kind) = plugin {
        let plugin_offset = d.len() + 9;
        d.push(3);
        d.extend_from_slice(&((plugin_offset + 1) as u64).to_le_bytes());
        d.push(kind);
        d.push(4);
        d.extend_from_slice(&1u32.to_le_bytes());
        d.extend_from_slice(&[kind, 2]);
        d.extend_from_slice(&(plugin_offset as u64).to_le_bytes());
        d.extend_from_slice(&0u32.to_le_bytes());
    }
    d
}

#[test]
fn permanent_delegates_and_unknown_plugins_are_rejected_on_assets_and_collections() {
    for collection in [false, true] {
        assert!(core_controls(
            &core_data(collection, Pubkey::new_unique(), None),
            collection
        )
        .is_ok());
        for kind in [0, 6, 9, 10, 11, 12, 13, 14] {
            assert!(core_controls(
                &core_data(collection, Pubkey::new_unique(), Some(kind)),
                collection
            )
            .is_ok());
        }
        for kind in [5, 7, 8, 15, 16, 17, 18, 255] {
            assert!(core_controls(
                &core_data(collection, Pubkey::new_unique(), Some(kind)),
                collection
            )
            .is_err());
        }
    }
}

#[test]
fn malformed_core_controls_and_offsets_fail_without_panics() {
    for collection in [false, true] {
        let valid = core_data(collection, Pubkey::new_unique(), Some(6));
        let base = core_data(collection, Pubkey::new_unique(), None).len();
        for len in 0..valid.len() {
            if len != base {
                assert!(core_controls(&valid[..len], collection).is_err());
            }
        }
        let mut bad = valid.clone();
        bad[base + 1..base + 9].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(core_controls(&bad, collection).is_err());
        for at in 0..valid.len() {
            for byte in [0, 1, 3, 127, 255] {
                let mut mutated = valid.clone();
                mutated[at] = byte;
                assert!(std::panic::catch_unwind(|| core_controls(&mutated, collection)).is_ok());
            }
        }
        let mut bad = valid.clone();
        let end = bad.len();
        bad[end - 4..].copy_from_slice(&1u32.to_le_bytes());
        assert!(core_controls(&bad, collection).is_err());
        bad.extend_from_slice(&[7]);
        assert!(core_controls(&bad, collection).is_err());
    }
}

fn check_mint(mut d: Vec<u8>, program: Pubkey) -> Result<u8, ProgramError> {
    let address = Pubkey::new_unique();
    let mut lamports = 1;
    mint(
        &AccountInfo::new(
            &address,
            false,
            false,
            &mut lamports,
            &mut d,
            &program,
            false,
            0,
        ),
        &program,
    )
}

#[test]
fn fee_mints_require_revoked_freeze_authority_and_safe_extensions() {
    let mut mint = vec![0; 82];
    mint[45] = 1;
    assert!(check_mint(mint.clone(), TOKEN).is_ok());
    mint[46] = 1;
    assert!(check_mint(mint.clone(), TOKEN).is_err());
    assert!(check_mint(mint.clone(), TOKEN22).is_err());
    mint[46] = 0;
    mint.resize(166, 0);
    mint[165] = 1;
    for kind in [18u16, 19] {
        let mut allowed = mint.clone();
        allowed.extend_from_slice(&kind.to_le_bytes());
        allowed.extend_from_slice(&0u16.to_le_bytes());
        assert!(check_mint(allowed, TOKEN22).is_ok());
    }
    for kind in [1u16, 6, 9, 12, 14, 16, 26, 255] {
        let mut unsafe_mint = mint.clone();
        unsafe_mint.extend_from_slice(&kind.to_le_bytes());
        unsafe_mint.extend_from_slice(&0u16.to_le_bytes());
        assert!(check_mint(unsafe_mint, TOKEN22).is_err());
    }
    for tail in [
        vec![18, 0, 1, 0],
        vec![18, 0, 0],
        vec![18, 0, 0, 0, 18, 0, 0, 0],
    ] {
        let mut malformed = mint.clone();
        malformed.extend_from_slice(&tail);
        assert!(check_mint(malformed, TOKEN22).is_err());
    }
}

#[test]
fn register_checks_creator_collection_controls_and_bounds_before_writing() {
    let id = Pubkey::new_unique();
    let creator_key = Pubkey::new_unique();
    let collection_key = Pubkey::new_unique();
    let asset_key = Pubkey::new_unique();
    let seed = [7u8; 32];
    let vault_key =
        Pubkey::find_program_address(&[b"fee-vault", creator_key.as_ref(), &seed], &id).0;
    let mut d = vec![0; HEADER + ENTRY];
    d[..8].copy_from_slice(MAGIC);
    d[8..40].copy_from_slice(creator_key.as_ref());
    d[40..72].copy_from_slice(&seed);
    d[72..104].copy_from_slice(collection_key.as_ref());
    d[329..331].copy_from_slice(&1u16.to_le_bytes());
    put(&mut d, 333, 1);
    let original = d.clone();
    let mut creator_data = vec![];
    let mut asset_data = core_data(false, collection_key, Some(7));
    let mut collection_data = core_data(true, collection_key, None);
    let mut balances = [1u64; 4];
    let (b0, rest) = balances.split_at_mut(1);
    let (b1, rest) = rest.split_at_mut(1);
    let (b2, b3) = rest.split_at_mut(1);
    let mut a = vec![
        AccountInfo::new(
            &creator_key,
            true,
            false,
            &mut b0[0],
            &mut creator_data,
            &system_program::ID,
            false,
            0,
        ),
        AccountInfo::new(&vault_key, false, true, &mut b1[0], &mut d, &id, false, 0),
        AccountInfo::new(
            &asset_key,
            false,
            false,
            &mut b2[0],
            &mut asset_data,
            &CORE,
            false,
            0,
        ),
        AccountInfo::new(
            &collection_key,
            false,
            false,
            &mut b3[0],
            &mut collection_data,
            &CORE,
            false,
            0,
        ),
    ];
    let mut ix = vec![1, 0, 0];
    ix.extend_from_slice(&1u64.to_le_bytes());
    assert!(process_instruction(&id, &a, &ix).is_err());
    assert_eq!(*a[1].data.borrow(), &original[..]);
    // Change only the plugin type to harmless attributes. The shared registry
    // points to the same raw plugin byte.
    let base = core_data(false, collection_key, None).len();
    {
        let mut asset = a[2].data.borrow_mut();
        asset[base + 9] = 6;
        asset[base + 15] = 6;
    }
    a[0].is_signer = false;
    assert!(process_instruction(&id, &a, &ix).is_err());
    a[0].is_signer = true;
    ix[1] = 1;
    assert!(process_instruction(&id, &a, &ix).is_err());
    ix[1] = 0;
    assert_eq!(*a[1].data.borrow(), &original[..]);
    assert!(process_instruction(&id, &a, &ix).is_ok());
    assert!(process_instruction(&id, &a, &ix).is_ok()); // exact resume
    a[1].data.borrow_mut()[349] = 1;
    assert!(process_instruction(&id, &a, &ix).is_err());
}

#[test]
fn interleaved_claims_and_transferred_rights_conserve_every_receipt() {
    let weights = [1u64, 2, 3, 5, 8];
    let total = weights.iter().sum();
    let mut paid = [0u64; 5];
    let mut received = 0u64;
    for step in 0..10_000usize {
        received += ((step * 17) % 97) as u64;
        let index = (step * 7) % weights.len();
        paid[index] += entitlement(received, weights[index], total, paid[index]).unwrap();
        assert!(paid.iter().sum::<u64>() <= received);
        assert_eq!(
            entitlement(received, weights[index], total, paid[index]).unwrap(),
            0
        );
    }
    for n in 0..weights.len() {
        paid[n] += entitlement(received, weights[n], total, paid[n]).unwrap();
    }
    assert!(received - paid.iter().sum::<u64>() < weights.len() as u64);
}

#[test]
fn malformed_instruction_dispatch_fails_closed() {
    let id = Pubkey::new_unique();
    for op in 0..=255u8 {
        for len in 1..310 {
            let mut data = vec![0; len];
            data[0] = op;
            assert!(process_instruction(&id, &[], &data).is_err());
        }
    }
    assert!(process_instruction(&id, &[], &[]).is_err());
}
