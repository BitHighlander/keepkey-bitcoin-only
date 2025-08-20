Must‑fix correctness issues

list_devices() return type doesn’t match collect()
Right now it declares -> Box<[Device<GlobalContext>]> but you call .collect() without boxing. That won’t compile (there’s no FromIterator for Box<[T]>). Either:

pub fn list_devices() -> Vec<Device<GlobalContext>> {
    rusb::devices()
        .unwrap()
        .iter()
        .filter(|d| {
            let dd = d.device_descriptor().unwrap();
            DEVICE_IDS.contains(&(dd.vendor_id(), dd.product_id()))
        })
        .collect::<Vec<_>>()
}


or:

pub fn list_devices() -> Box<[Device<GlobalContext>]> {
    rusb::devices()
        .unwrap()
        .iter()
        .filter(|d| {
            let dd = d.device_descriptor().unwrap();
            DEVICE_IDS.contains(&(dd.vendor_id(), dd.product_id()))
        })
        .collect::<Vec<_>>()
        .into_boxed_slice()
}


Cache lookup is O(n) even though you key by bus:addr
In device_to_friendly_with_cache, you iterate the whole map to match bus/addr, but you also store entries keyed by bus_addr_key. Just do a direct lookup and update last_seen:

let bus_addr_key = format!("{}:{}", bus, addr);

if let Ok(mut cache) = DEVICE_CACHE.lock() {
    if let Some(info) = cache.get_mut(&bus_addr_key) {
        info.last_seen = std::time::Instant::now();
        return FriendlyUsbDevice::new(
            info.stable_id.clone(),
            info.vid,
            info.pid,
            info.manufacturer.clone(),
            info.product.clone(),
            info.serial_number.clone(),
        );
    }
}


(And keep the “serial reuse” path as a secondary lookup—see “Stability” below.)

You search + open every USB device to match serial in get_device_features_for_device, then never use the rusb::Device you found
That whole probe is heavy (especially on Windows) and can race with other clients. You immediately switch to DeviceQueueFactory::create_transport_for_device(target_device). Remove the rusb open/scan from this function entirely and rely on the queue’s transport selection. If you want a sanity check, compare target_device.vid/pid/serial_number against list_connected_devices() and bail early if not present—no need to open handles.

Aggressive unconditional reset() before talking to the device
transport.reset() right before Initialize can cause exactly the thrash you’re fighting (particularly on Windows). Make it conditional—only reset after a first failure or if you detect Busy/Timeout:

let init = Initialize::default().into();
let features_msg = match transport.handle(init.clone()) {
    Ok(m) => Ok(m),
    Err(e) => {
        log::warn!("{TAG} init failed ({e}); trying reset then retry...");
        let _ = transport.reset(); // best-effort
        std::thread::sleep(std::time::Duration::from_millis(150));
        transport.handle(init)
    }
}?; // propagate on second failure


detect_device_state() over-classifies uninitialized devices as OOB
You return OobWalletMode just because initialized == false, even without raw_len. That will mislabel normal, freshly‑wiped devices. Gate OOB on both signals (short response and uninitialized), otherwise treat as WalletMode (uninitialized):

if !features.initialized {
    if let Some(len) = raw_len {
        if len < 64 { return DetectedDeviceState::OobWalletMode; }
    }
    return DetectedDeviceState::WalletMode; // uninitialized but not necessarily OOB
}

Stability & Windows flapping (practical improvements)

Prefer serial as the canonical ID and reuse it across bus/addr changes (you already started)
Keep the “serial → stable_id” reuse you have, but also update last_seen for the reused entry, and add an alias entry for the new bus:addr so future lookups hit the O(1) path:

if let Some(serial) = serial_number.clone().filter(|s| !s.is_empty()) {
    if let Ok(mut cache) = DEVICE_CACHE.lock() {
        if let Some((_k, info)) = cache.iter_mut().find(|(_, i)| i.serial_number.as_deref() == Some(&serial)) {
            info.last_seen = std::time::Instant::now();
            cache.insert(bus_addr_key.clone(), CachedDeviceInfo { last_seen: info.last_seen, ..info.clone() });
            return FriendlyUsbDevice::new(info.stable_id.clone(), vid, pid, manufacturer, product, Some(serial));
        }
    }
}


Add a tiny Windows settle before the first Initialize
Right before the first handle(Initialize), add:

#[cfg(target_os = "windows")]
std::thread::sleep(std::time::Duration::from_millis(600..900));


Empirically this removes a lot of “timeout on first features” after enumeration.

Backoff on fallback attempts (you already do) — consider stretching to 250, 500, 750 ms on noisy hosts.

HID path: don’t create a new HidApi for each device; you already do it once in the enumerate path. Keep that and reuse where possible. Also, you can early‑exit if target_device.serial_number is set and HidTransport::new_for_device(Some(serial)) fails with a hard error that isn’t “not found”.

Smaller cleanup / consistency

The “bootloader_version” field currently stores the bootloader hash hex. That’s fine as data, but the name is misleading. Either rename to bootloader_hash_hex or keep both fields and only fill bootloader_version when you actually map hashes to versions.

Manufacturer fallback says "KeyHodlers, LLC" (typo). If you want a friendly default, "KeepKey" is fine; otherwise leave None.

std::thread::sleep is acceptable here (non‑async), but if any of this gets called from async contexts later, prefer tokio::time::sleep to avoid blocking the runtime.

Consider lifting the 30s cache expiry to ~60–90s on Windows; hotplug churn is more frequent there.

Optional: stronger identity coalescing

If you want to be extra defensive against ID flips during connect:

Maintain a HashMap<String /*serial*/, String /*stable_id*/> alongside the bus:addr cache, so you don’t have to scan the cache for a matching serial.

When you mint a new stable_id for serial‑less devices (bus/addr), keep that mapping alive for a short TTL; if a serial appears later for the same physical device, migrate the stable id to the serial.

If you do just the must‑fixes (return type, cache O(1) lookup, remove unused rusb open + make reset conditional, and soften OOB detection), plus the Windows settle delay, you’ll get immediate improvements: fewer first‑Initialize timeouts, fewer disconnect/reconnect cascades, and stable IDs across bus/addr changes.





Must-fix bugs

You call a function that doesn’t exist
In try_get_device_features() you check:

crate::commands::is_potentially_same_device_in_pin_flow(&device.unique_id)


I don’t see this defined anywhere (you have are_devices_potentially_same, is_device_in_pin_flow, etc.). This will fail to compile. Either remove that second check or implement it (e.g., “if any alias of this id is in PIN flow”).

Disconnect logic ignores aliases → false “disconnect”
You compare last_devices vs current_devices by unique_id only. When the same physical device flips identity (serial ↔ bus/addr), you’ll emit disconnect + connect. Canonicalize before comparison:

let canon = |id: &str| crate::commands::get_canonical_device_id(id);

// when checking new connections
if !last_devices.iter().any(|d| canon(&d.unique_id) == canon(&device.unique_id)) { ... }

// when checking disconnections
for device in &last_devices {
    if !current_devices.iter().any(|d| canon(&d.unique_id) == canon(&device.unique_id)) {
        // ... treat as real disconnect
    }
}


Duplicate detection can still fire on the same scan pass
You look for a “duplicate” inside current_devices and alias it, but then you still compare last_devices vs current_devices using raw ids. After registering an alias, immediately rewrite device.unique_id (or keep a canonical_id alongside) so subsequent checks use the same identity in this tick.

Flap & race reduction (small, high impact)

Add a small disconnect debounce on Windows
Windows enumeration is noisy. Before you emit “disconnected”, wait a moment in case it reappears with a new bus/addr:

#[cfg(target_os = "windows")]
const DISCONNECT_DEBOUNCE_MS: u64 = 300;

#[cfg(target_os = "windows")]
async fn likely_still_gone(id: &str) -> bool {
    tokio::time::sleep(Duration::from_millis(DISCONNECT_DEBOUNCE_MS)).await;
    !keepkey_rust::features::list_connected_devices()
        .iter()
        .any(|d| crate::commands::are_devices_potentially_same(&d.unique_id, id))
}


Use this before you emit device:disconnected / clean the queue.

First-fetch settle is good; widen timeout a bit on Windows
try_get_device_features() uses a 5s timeout. On some Windows hosts, first GetFeatures can take 6–8s right after plug. Make it 10s (Windows only) and keep your 3 tries/backoff.

#[cfg(target_os = "windows")]
let per_attempt = Duration::from_secs(10);
#[cfg(not(target_os = "windows"))]
let per_attempt = Duration::from_secs(5);

match tokio::time::timeout(per_attempt, queue_handle.get_features()).await { ... }


Don’t emit device:connected before alias/canonical resolution
Right now you emit device:connected immediately; if you later alias it, the UI may see two “devices.” Emit after aliasing and using the canonical id, and consider using your emit_or_queue_event helper consistently:

let connected_payload = serde_json::json!({ "device": device_canonicalized });
let _ = crate::commands::emit_or_queue_event(&app_handle, "device:connected", connected_payload).await;

Robustness & consistency

Make alias registration two-way + with TTL
Your add_recovery_device_alias(new → existing) is one-directional and lives in “recovery” space. For general hotplug stability, keep a small alias map for all devices (serial ↔ bus/addr) with TTL (e.g., 60–90s). That way get_canonical_device_id() always resolves to serial when available.

Avoid spawning multiple workers for the same physical device
You already dedupe on canonical id before spawning a worker—good. Also gate feature-fetch per device with a small mutex to avoid concurrent get_features() races (one in controller, another from UI):

// inside your queue handle struct or a global map keyed by canonical id
static IN_FLIGHT: Lazy<DashMap<String, Arc<tokio::sync::Mutex<()>>>> = ...
let guard = IN_FLIGHT.entry(canonical_id.clone())
    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
    .clone()
    .lock()
    .await;
// do get_features() here


Status spam protection
You emit multiple “status:update” strings in quick succession. Consider coalescing identical status messages within the last second to reduce UI flicker.

Use emit_or_queue_event for all device-critical events
You already use it for device:ready and device:features-updated. Do the same for device:connected, device:pin-unlock-needed, device:passphrase-unlock-needed, etc., so early events don’t get dropped before the frontend subscribes.

Tiny fixes (safe, quick)

In spawn_event_controller, you wrap the controller in Arc<Mutex<_>> and app.manage() it—nice. On stop(), you spawn a task to await the joinhandle with a 5s timeout; good. Consider JoinHandle::abort() as a last resort if it doesn’t finish.

Your “older device” PID logic lives in lower layers already; here, just keep the settle + retries.

Status strings: consider including last 6–8 chars of canonical id always, to be stable across alias flips.

If you patch (1–3) and add (4–5), you’ll eliminate most of the “connect → GetFeatures → disconnect → reconnect” churn and avoid duplicate UI devices. If you want, paste the alias/TTL helper and I’ll drop in a compact implementation you can use across both the features layer and the event controller.