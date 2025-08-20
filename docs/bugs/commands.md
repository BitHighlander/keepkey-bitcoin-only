You’re not hallucinating—you’ve actually got a lot of the right pieces here. The architecture (single device queue per device, PIN/Passphrase flow guards, caching, backoff, and logging) is solid. That said, I see a few concrete bugs and sharp edges you can fix right now to reduce thrash and weird states:

High-impact fixes (real bugs)

get_queue_status uses the wrong key
You documented that LastResponsesMap is keyed by request_id, but get_queue_status() does:

let last_response = responses.get(&id).cloned(); // id = device_id


That will almost always be None. Either:

change the map to be keyed by device_id, or

track and pass a request_id into this command and look up by that key.

Derivation path in trigger_pin_request isn’t hardened
You send:

address_n: vec![44, 0, 0, 0, 0]


KeepKey expects hardened for purpose/account (44' / 0' / 0' / 0 / 0). Use your own helper:

address_n: parse_derivation_path("m/44'/0'/0'/0/0")?


(or set the high bit yourself for the first three indices).

Test expectations vs. logic disagree
test_bootloader_mode_device_status() asserts that “device in bootloader mode always needs bootloader update”, but your evaluation marks 2.1.4 bootloaders as up-to-date (correct). The test should expect needs_bootloader_update == false for 2.1.4 while in bootloader mode.

Mixed lock types in async paths
You mix std::sync::Mutex (PIN_SESSIONS, DEVICE_PIN_FLOWS, etc.) with async .await code. This can cause blocking of the async runtime. Prefer tokio::sync::Mutex/RwLock everywhere you lock in an async flow. (You already use tokio::sync in several places—make it consistent.)

Inconsistent PIN encoding helpers
Some places build the PIN as (b'0' + pos) as char and others as pos.to_string(). Both end up “123…”, but centralize this into one helper to avoid drift and logging confusion.

Race/UX polish (reduces Windows flapping)

Windows settle delay before first GetFeatures
Right before your first queue_handle.get_features() attempt in get_device_status (and in get_device_info_by_id), add:

#[cfg(target_os = "windows")]
tokio::time::sleep(Duration::from_millis(800)).await;


This alone often removes the “timeout on first feature fetch” after enumeration.

Disconnect debounce + identity aliasing everywhere
You already have aliasing helpers, but get_canonical_device_id() relies on RECOVERY_DEVICE_ALIASES. Make a small global alias map (serial ↔ bus/addr) used by all flows (PIN, recovery, queue lookup). When the same serial reappears on a new bus/addr, keep the canonical ID stable and don’t tear down the queue. Also add a 200–300 ms debounce before emitting “disconnect” on the Windows poller side (wherever that lives).

One GetFeatures at a time per device
You do retries/backoff nicely, but ensure a per-device in-flight guard so concurrent callers can’t race get_features() (easy to add with a tokio::sync::Mutex<()> in the queue handle).

Smaller correctness notes

In send_passphrase() error path you reference super::device::queue::PASSPHRASE_REQUEST_STATE while elsewhere it’s device::PASSPHRASE_REQUEST_STATE. Make those paths consistent.

Hardcoded versions in evaluate_device_status (“2.1.4” bootloader, “7.10.0” firmware) are fine short-term, but keep them centralized behind one source of truth so UI/messages don’t drift.

LAST_STATUS_CHECK throttle is good; 500 ms is a sane default. If support logs still show thrash, bump to 750–1000 ms on Windows only.

Quick patches you can drop in

Harden path in trigger_pin_request:

// replace current vec![44,0,0,0,0]
let address_n = parse_derivation_path("m/44'/0'/0'/0/0")
    .map_err(|e| format!("derive path failed: {e}"))?;
let get_address = keepkey_rust::messages::GetAddress {
    address_n,
    coin_name: Some("Bitcoin".into()),
    script_type: Some(0),
    show_display: Some(false),
    ..Default::default()
};


Settle delay before first features fetch (Windows):

#[cfg(target_os = "windows")]
if attempt == 1 {
    tokio::time::sleep(Duration::from_millis(800)).await;
}


Fix get_queue_status keying (option A — key by device):

Change the map to HashMap<String /*device_id*/, DeviceResponse>, and on every response insert under both keys if you still need request lookup.

—or (option B — keep request_id key): pass a request_id: Option<String> into get_queue_status and, when present, look up by that.

If you apply the three “high-impact” fixes (wrong key; hardened path; fix the test), plus the Windows settle delay, you should immediately see:

fewer 10s timeouts on the first GetFeatures,

fewer “disconnect/reconnect” cascades on Windows, and

accurate queue status reporting.

If you want, paste your USB poller (Windows) and the queue handle internals; I’ll add a tiny disconnect debounce and a safe in-flight guard tailored to your code.