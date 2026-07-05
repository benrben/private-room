//! ADD-11 — Touch ID unlock.
//!
//! Stores a room's password in the macOS Keychain guarded by biometrics, so the
//! room can be unlocked with a fingerprint instead of typing. The secret lives
//! ONLY in the Keychain (never in the room file or any plain file), protected by
//! a `SecAccessControl` with the `biometryCurrentSet` constraint: it can only be
//! read after a live Touch ID / Face ID match against the *currently enrolled*
//! set. Re-enrolling a finger invalidates the item, which is what we want.
//!
//! Items are generic passwords keyed by:
//!   service = "PrivateRoom", account = <room file path>
//! in the data-protection keychain (required for biometric access control).

/// Keychain service; the account is the room's file path.
const SERVICE: &str = "PrivateRoom";

// Not exported by security-framework-sys; taken from <Security/SecBase.h>.
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

#[cfg(target_os = "macos")]
mod imp {
    use super::{ERR_SEC_INTERACTION_NOT_ALLOWED, ERR_SEC_USER_CANCELED, SERVICE};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::base::Error as SfError;
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        AccessControlOptions, PasswordOptions,
    };
    use security_framework_sys::base::errSecItemNotFound;
    use security_framework_sys::item::{
        kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword,
        kSecReturnAttributes, kSecUseAuthenticationUI, kSecUseAuthenticationUISkip,
        kSecUseDataProtectionKeychain,
    };
    use security_framework_sys::keychain_item::SecItemCopyMatching;

    /// Turn a Security.framework error into a message the UI can show. Cancel /
    /// no-match map to gentle text so the unlock screen falls back to a password.
    fn map_err(e: SfError) -> String {
        match e.code() {
            ERR_SEC_USER_CANCELED => "Touch ID was cancelled.".into(),
            -25293 /* errSecAuthFailed */ => "Touch ID did not match.".into(),
            code if code == errSecItemNotFound => "No Touch ID entry for this room.".into(),
            // errSecMissingEntitlement — the Keychain is unavailable to this
            // build (unsigned/sandboxed run, or no Secure Enclave). Speak plainly
            // and keep the raw code out of the user's face; password still works.
            -34018 => "Touch ID isn't available on this Mac right now. You can still unlock with your password.".into(),
            // Any other OSStatus: a friendly line, with the raw code tucked at
            // the end in brackets for support without leading with jargon.
            code => format!(
                "Touch ID isn't available right now. You can still unlock with your password. [code {code}]"
            ),
        }
    }

    /// Does a biometric entry exist for this room? Queries attributes ONLY (no
    /// `kSecReturnData`) and skips any auth UI, so it never triggers a prompt —
    /// safe to call the moment the unlock screen appears.
    pub fn has(path: &str) -> bool {
        let pairs: Vec<(CFString, CFType)> = vec![
            (
                unsafe { CFString::wrap_under_get_rule(kSecClass) },
                unsafe { CFString::wrap_under_get_rule(kSecClassGenericPassword) }.into_CFType(),
            ),
            (
                unsafe { CFString::wrap_under_get_rule(kSecAttrService) },
                CFString::from(SERVICE).into_CFType(),
            ),
            (
                unsafe { CFString::wrap_under_get_rule(kSecAttrAccount) },
                CFString::from(path).into_CFType(),
            ),
            (
                unsafe { CFString::wrap_under_get_rule(kSecReturnAttributes) },
                CFBoolean::from(true).into_CFType(),
            ),
            (
                unsafe { CFString::wrap_under_get_rule(kSecUseDataProtectionKeychain) },
                CFBoolean::from(true).into_CFType(),
            ),
            (
                unsafe { CFString::wrap_under_get_rule(kSecUseAuthenticationUI) },
                unsafe { CFString::wrap_under_get_rule(kSecUseAuthenticationUISkip) }.into_CFType(),
            ),
        ];
        let query = CFDictionary::from_CFType_pairs(&pairs);
        let mut result: core_foundation_sys::base::CFTypeRef = std::ptr::null();
        let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
        // Release anything handed back (attributes dictionary) via RAII.
        if !result.is_null() {
            unsafe { CFType::wrap_under_create_rule(result) };
        }
        // Present-but-locked (InteractionNotAllowed) still means the item exists.
        status == 0 || status == ERR_SEC_INTERACTION_NOT_ALLOWED
    }

    /// Store `password` for `path`, guarded by `biometryCurrentSet`, in the
    /// data-protection keychain, marked "this device only" so it never syncs.
    /// Any existing entry is replaced. Creating does not require a prompt.
    pub fn store(path: &str, password: &str) -> Result<(), String> {
        // Replace cleanly: drop any prior item first so we never hit the
        // authenticated update path on a biometric item.
        let _ = delete(path);

        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
        )
        .map_err(|e| format!("Could not create biometric access control ({}).", e.code()))?;

        let mut opts = PasswordOptions::new_generic_password(SERVICE, path);
        opts.set_access_control(access);
        opts.use_protected_keychain();
        opts.set_label("Private Room — Touch ID unlock");

        set_generic_password_options(password.as_bytes(), opts).map_err(map_err)
    }

    /// Trigger the system biometric prompt and return the stored password.
    /// Requesting the data forces the LocalAuthentication prompt; cancel / no
    /// match surface as a clear error so the UI can fall back to typing.
    pub fn read(path: &str) -> Result<String, String> {
        let mut opts = PasswordOptions::new_generic_password(SERVICE, path);
        opts.use_protected_keychain();
        let bytes = generic_password(opts).map_err(map_err)?;
        String::from_utf8(bytes).map_err(|_| "Stored secret was not valid UTF-8.".to_string())
    }

    /// Delete the entry for `path`. Missing is success (idempotent).
    pub fn delete(path: &str) -> Result<(), String> {
        let mut opts = PasswordOptions::new_generic_password(SERVICE, path);
        opts.use_protected_keychain();
        match delete_generic_password_options(opts) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == errSecItemNotFound => Ok(()),
            Err(e) => Err(map_err(e)),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    const MSG: &str = "Touch ID is only available on macOS.";
    pub fn has(_path: &str) -> bool {
        false
    }
    pub fn store(_path: &str, _password: &str) -> Result<(), String> {
        Err(MSG.into())
    }
    pub fn read(_path: &str) -> Result<String, String> {
        Err(MSG.into())
    }
    pub fn delete(_path: &str) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::{delete, has, read, store};
