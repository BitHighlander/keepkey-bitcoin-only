import { useEffect, useState, useRef } from 'react'
import { BootloaderUpdateDialog } from './BootloaderUpdateDialog'
import { FirmwareUpdateDialog } from './FirmwareUpdateDialog'
import { SetupWizard } from './SetupWizard'
import { EnterBootloaderModeDialog } from './EnterBootloaderModeDialog'
import { PinUnlockDialog } from './PinUnlockDialog'
import { ErrorBoundary } from './ErrorBoundary'
import type { DeviceStatus, DeviceFeatures } from '../types/device'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useWallet } from '../contexts/WalletContext'
import { useDeviceInvalidStateDialog, usePinPassphraseDialog } from '../contexts/DialogContext'
import { useOnboardingGate } from '../contexts/OnboardingGateContext'
import { deviceLogger, LogCategory, logDevice, logDeviceError, logStateChange } from '../utils/deviceLogger'

interface DeviceUpdateManagerProps {
  // Optional callback when all updates/setup is complete
  onComplete?: () => void
  // Optional callback to notify when setup wizard active state changes
  onSetupWizardActiveChange?: (active: boolean) => void
}

export const DeviceUpdateManager = ({ onComplete, onSetupWizardActiveChange }: DeviceUpdateManagerProps) => {
  // Start correlation for this device manager session
  const sessionCorrelationId = deviceLogger.startCorrelation();
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null)
  const [showEnterBootloaderMode, setShowEnterBootloaderMode] = useState(false)
  const [showBootloaderUpdate, setShowBootloaderUpdate] = useState(false)
  const [showFirmwareUpdate, setShowFirmwareUpdate] = useState(false)
  const [showWalletCreation, setShowWalletCreation] = useState(false)
  const [showPinUnlock, setShowPinUnlock] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [connectedDeviceId, setConnectedDeviceId] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  
  // Use ref to track setup wizard state for persistence
  const setupWizardActive = useRef(false)
  const setupWizardDeviceId = useRef<string | null>(null)
  const [persistentDeviceId, setPersistentDeviceId] = useState<string | null>(null)
  
  // Track if we've already triggered PIN for a device to prevent duplicates
  const pinTriggeredForDevice = useRef<Set<string>>(new Set())
  const [setupInProgress, setSetupInProgress] = useState(false) // Track if setup is in progress
  const justCompletedBootloaderUpdate = useRef(false) // Track if we just did a bootloader update
  const firmwareUpdateInProgress = useRef(false) // Track if firmware update is happening

  // Get wallet context for portfolio loading
  const { refreshPortfolio, fetchedXpubs } = useWallet()
  
  // Get device invalid state dialog hook
  const deviceInvalidStateDialog = useDeviceInvalidStateDialog()
  const authDialog = usePinPassphraseDialog()
  
  // Get onboarding gate state
  const { allowDeviceInteractions, onboardingInProgress } = useOnboardingGate()

  // Function to try getting device status via command when events fail
  const tryGetDeviceStatus = async (deviceId: string, attempt = 1) => {
    const maxAttempts = 3
    console.log(`Attempting to get device status for ${deviceId} (attempt ${attempt}/${maxAttempts})`)
    
    try {
      const status = await invoke<DeviceStatus | null>('get_device_status', { deviceId })
      if (status) {
        console.log('Successfully got device status via command:', status)
        setDeviceStatus(status)
        handleDeviceStatus(status)
        return true
      } else {
        console.log('No device status returned')
        return false
      }
    } catch (error) {
      console.error(`Failed to get device status (attempt ${attempt}):`, error)
      
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000) // Exponential backoff, max 5s
        console.log(`Retrying in ${delay}ms...`)
        setTimeout(() => {
          tryGetDeviceStatus(deviceId, attempt + 1)
        }, delay)
      } else {
        console.error('Max attempts reached, giving up on getting device status')
      }
      return false
    }
  }

  // Function to handle device status and determine which dialog to show
  const handleDeviceStatus = (status: DeviceStatus) => {
    const correlationId = deviceLogger.startCorrelation();
    
    deviceLogger.info(LogCategory.DEVICE_CONNECTION, 'Handling device status', {
      deviceId: status.deviceId,
      needsInitialization: status.needsInitialization,
      needsFirmwareUpdate: status.needsFirmwareUpdate,
      needsBootloaderUpdate: status.needsBootloaderUpdate,
      needsPinUnlock: status.needsPinUnlock,
      features: status.features,
      correlationId
    });
    
    console.log('🔧 DeviceUpdateManager: Handling device status:', status)
    console.log('🔧 DeviceUpdateManager: Status needs_initialization:', status.needsInitialization)
    console.log('🔧 DeviceUpdateManager: Status needs_firmware_update:', status.needsFirmwareUpdate)
    console.log('🔧 DeviceUpdateManager: Status needs_bootloader_update:', status.needsBootloaderUpdate)
    console.log('🔧 DeviceUpdateManager: Status needs_pin_unlock:', status.needsPinUnlock)
    
    // CRITICAL: Always hide invalid state dialog when handling new status
    // This ensures we don't have overlapping dialogs
    if (deviceInvalidStateDialog.isShowing(status.deviceId)) {
      console.log('🔧 Hiding invalid state dialog before handling new status')
      deviceInvalidStateDialog.hide(status.deviceId)
    }
    
    // Check if device is in bootloader mode - handle both field formats from backend
    const isInBootloaderMode = status.features?.bootloader_mode || status.features?.bootloaderMode || false
    console.log('🔧 Bootloader mode check:', {
      bootloader_mode: status.features?.bootloader_mode,
      bootloaderMode: status.features?.bootloaderMode,
      isInBootloaderMode,
      needsBootloaderUpdate: status.needsBootloaderUpdate,
      hasBootloaderCheck: !!status.bootloaderCheck
    })
    
    // Determine which dialog to show based on priority
    // IMPORTANT: If setup wizard is already showing, don't interrupt it
    if (setupWizardActive.current) {
      console.log('🔧 DeviceUpdateManager: Setup wizard is already showing - keeping it visible')
      return; // Don't change state while setup wizard is active
    }
    
    // IMPORTANT: Check initialization FIRST - setup wizard should take priority over EVERYTHING
    // Even if device is in bootloader mode, if it needs initialization, show setup wizard
    // Check both explicit needsInitialization flag AND the initialized feature flag
    // SPECIAL CASE: If device is in bootloader mode with "Unknown" firmware, it's likely uninitialized
    const hasUnknownFirmware = status.firmwareCheck?.currentVersion === 'Unknown' || 
                               status.firmwareCheck?.currentVersion === undefined;
    const deviceNeedsInitialization = status.needsInitialization || 
                                    status.features?.initialized === false || 
                                    status.features?.initialized === undefined ||
                                    (isInBootloaderMode && hasUnknownFirmware);
    
    if (deviceNeedsInitialization) {
      // Check if recovery is in progress - if so, don't interfere
      if ((window as any).KEEPKEY_RECOVERY_IN_PROGRESS) {
        console.log('🛡️ DeviceUpdateManager: Recovery in progress - IGNORING initialization request')
        console.log('🛡️ DeviceUpdateManager: Keeping current state to protect recovery')
        return; // Don't change any state during recovery
      }
      
      console.log('🔧 DeviceUpdateManager: Device needs initialization - SHOULD SHOW SETUP WIZARD')
      console.log('🔧 DeviceUpdateManager: Initialization check:', {
        needsInitialization: status.needsInitialization,
        initialized: status.features?.initialized,
        hasUnknownFirmware,
        currentFirmware: status.firmwareCheck?.currentVersion,
        deviceNeedsInitialization,
        isInBootloaderMode,
        reason: hasUnknownFirmware && isInBootloaderMode ? 'Bootloader mode with unknown firmware' : 'Normal initialization needed'
      })
      console.log('🔧 DeviceUpdateManager: Setting showWalletCreation = true')
      setShowEnterBootloaderMode(false)
      setShowBootloaderUpdate(false)
      setShowFirmwareUpdate(false)
      setShowWalletCreation(true)
      setupWizardActive.current = true
      setupWizardDeviceId.current = status.deviceId
      setPersistentDeviceId(status.deviceId) // Save device ID for persistence
      setSetupInProgress(true) // Mark setup as in progress
      onSetupWizardActiveChange?.(true)
      return; // Exit early - setup wizard takes absolute priority
    } else if (status.needsPinUnlock) {
      // PIN UNLOCK HAS PRIORITY OVER ALL UPDATES
      // Device is initialized but locked with PIN - this is handled by the PIN unlock event listener
      console.log('🔒 DeviceUpdateManager: Device needs PIN unlock - PRIORITY OVER UPDATES')
      // Don't call onComplete() here - PIN unlock dialog will be shown via the pin-unlock-needed event
      // Just ensure other dialogs are hidden
      setShowEnterBootloaderMode(false)
      setShowBootloaderUpdate(false)
      setShowFirmwareUpdate(false)
      setShowWalletCreation(false)
      // showPinUnlock will be set by the pin-unlock-needed event listener
      return; // Exit early - PIN has priority
    } else if (status.needsBootloaderUpdate && status.bootloaderCheck) {
      // Only update bootloader if device is NOT initialized
      // Initialized devices can skip bootloader updates
      const isInitialized = status.features?.initialized === true
      if (isInitialized) {
        console.log('🔧 Device is initialized - skipping bootloader update')
        // Device is ready (PIN was already handled above)
        console.log('✅ Device is ready after skipping bootloader update')
        setShowEnterBootloaderMode(false)
        setShowBootloaderUpdate(false)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
        setShowPinUnlock(false)
        onComplete?.()
      } else if (isInBootloaderMode) {
        // Device needs bootloader update AND is in bootloader mode -> show update dialog
        console.log('Device needs bootloader update and is in bootloader mode')
        setShowEnterBootloaderMode(false)
        setShowBootloaderUpdate(true)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
      } else {
        // Device needs bootloader update but NOT in bootloader mode -> show enter bootloader mode dialog
        console.log('Device needs bootloader update but not in bootloader mode')
        setShowEnterBootloaderMode(true)
        setShowBootloaderUpdate(false)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
      }
    } else if (status.needsFirmwareUpdate) {
      // Only update firmware if device is NOT initialized
      // Initialized devices can skip firmware updates
      const isInitialized = status.features?.initialized === true
      if (isInitialized) {
        console.log('🔧 Device is initialized - skipping firmware update')
        // Device is ready (PIN was already handled above)
        console.log('✅ Device is ready after skipping firmware update')
        setShowEnterBootloaderMode(false)
        setShowBootloaderUpdate(false)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
        setShowPinUnlock(false)
        onComplete?.()
      } else {
        console.log('Device needs firmware update')
        console.log('🔧 DeviceUpdateManager: Firmware update needed:', {
          needsFirmwareUpdate: status.needsFirmwareUpdate,
          firmwareCheck: status.firmwareCheck,
          currentVersion: status.firmwareCheck?.currentVersion,
          latestVersion: status.firmwareCheck?.latestVersion,
          features: status.features,
          isInBootloaderMode
        })
        
        // CRITICAL: Only show firmware update if actually in bootloader mode
        if (isInBootloaderMode && !status.needsBootloaderUpdate) {
          // Device is already in bootloader mode with correct bootloader version
          // Show firmware update dialog directly
          console.log('🔧 DeviceUpdateManager: Device in bootloader mode with correct bootloader, showing firmware update')
          setShowEnterBootloaderMode(false)
          setShowBootloaderUpdate(false)
          setShowFirmwareUpdate(true)
          setShowWalletCreation(false)
        } else if (!isInBootloaderMode) {
          // Device needs firmware update but is NOT in bootloader mode
          // Must enter bootloader mode first!
          console.log('🔧 DeviceUpdateManager: Device needs firmware update but NOT in bootloader mode - showing enter bootloader dialog')
          setShowEnterBootloaderMode(true)  // Show enter bootloader mode dialog
          setShowBootloaderUpdate(false)
          setShowFirmwareUpdate(false)      // Don't show firmware update yet
          setShowWalletCreation(false)
        } else {
          // Shouldn't happen, but handle edge case
          console.log('🔧 DeviceUpdateManager: Unexpected state - needs firmware but bootloader needs update too')
          setShowEnterBootloaderMode(false)
          setShowBootloaderUpdate(false)
          setShowFirmwareUpdate(true)
          setShowWalletCreation(false)
        }
      }
    } else {
      // Device is ready
      console.log('🔧 DeviceUpdateManager: Device is ready, no updates needed')
      console.log('🔧 DeviceUpdateManager: Calling onComplete() - this will show VaultInterface')
      setShowEnterBootloaderMode(false)
      setShowBootloaderUpdate(false)
      setShowFirmwareUpdate(false)
      setShowWalletCreation(false)
      setShowPinUnlock(false)
      onComplete?.()
    }
  }

  useEffect(() => {
    let featuresUnsubscribe: Promise<() => void> | null = null
    let connectedUnsubscribe: Promise<() => void> | null = null
    let timeoutId: NodeJS.Timeout | null = null

    const setupListeners = async () => {
      console.log('DeviceUpdateManager: Setting up event listeners...')
      
      // Listen for device features updates which include status (primary method)
      featuresUnsubscribe = listen<{
        deviceId: string
        features: DeviceFeatures
        status: DeviceStatus
      }>('device:features-updated', (event) => {
        deviceLogger.logEvent('received', 'device:features-updated', event.payload);
        console.log('🔧 DeviceUpdateManager: Device features updated event received:', event.payload)
        const { status } = event.payload
        console.log('🔧 DeviceUpdateManager: Extracted status from event:', status)
        
        // If we just completed a bootloader update and setup is in progress,
        // update the persistent device ID to the new one
        if (justCompletedBootloaderUpdate.current && setupInProgress && status.deviceId !== persistentDeviceId) {
          deviceLogger.warn(LogCategory.DEVICE_ID, 'Device ID changed after bootloader update', {
            oldId: persistentDeviceId,
            newId: status.deviceId,
            reason: 'bootloader_update',
            setupInProgress
          });
          console.log('🔄 Device ID changed after bootloader update:', {
            oldId: persistentDeviceId,
            newId: status.deviceId
          })
          setPersistentDeviceId(status.deviceId)
          setupWizardDeviceId.current = status.deviceId
          justCompletedBootloaderUpdate.current = false // Reset the flag
        }
        console.log('🔧 DeviceUpdateManager: Device status details:', {
          deviceId: status.deviceId,
          connected: status.connected,
          needsBootloaderUpdate: status.needsBootloaderUpdate,
          needsFirmwareUpdate: status.needsFirmwareUpdate,
          needsInitialization: status.needsInitialization,
          needsPinUnlock: status.needsPinUnlock,
          firmwareCheck: status.firmwareCheck,
          bootloaderCheck: status.bootloaderCheck,
          features: status.features
        })
        
        // Check if recovery is in progress - if so, be very careful about state changes
        if ((window as any).KEEPKEY_RECOVERY_IN_PROGRESS) {
          console.log('🛡️ DeviceUpdateManager: Recovery in progress - handling features event carefully')
          // Still update device status (for recovery to work) but don't trigger UI changes
          setDeviceStatus(status)
          setConnectedDeviceId(status.deviceId)
          setRetryCount(0)
          // DO NOT call handleDeviceStatus during recovery to prevent UI conflicts
          return;
        }
        
        setDeviceStatus(status)
        setConnectedDeviceId(status.deviceId)
        setRetryCount(0) // Reset retry count on successful event
        
        // CRITICAL: Don't handle device status if setup is in progress
        // This prevents the setup wizard from being hidden on reconnection
        if (!setupInProgress) {
          handleDeviceStatus(status)
        } else {
          console.log('🔧 DeviceUpdateManager: Setup in progress, not handling device status to preserve wizard')
        }
      })

      // Listen for basic device connected events as fallback
      connectedUnsubscribe = listen<{
        unique_id: string
        name: string
        vid: number
        pid: number
        manufacturer?: string
        product?: string
        serial_number?: string
        is_keepkey: boolean
      }>('device:connected', (event) => {
        const device = event.payload
        deviceLogger.logEvent('received', 'device:connected', device);
        deviceLogger.info(LogCategory.DEVICE_CONNECTION, 'Device connected (fallback)', {
          uniqueId: device.unique_id,
          vid: device.vid,
          pid: device.pid,
          serialNumber: device.serial_number,
          isKeepKey: device.is_keepkey
        });
        console.log('Device connected event received (fallback):', device)
        
        if (device.is_keepkey) {
          setConnectedDeviceId(device.unique_id)
          
          // Set a timeout to try getting device status if features event doesn't come
          if (timeoutId) clearTimeout(timeoutId)
          timeoutId = setTimeout(() => {
            console.log('Features event timeout, trying direct device status call...')
            tryGetDeviceStatus(device.unique_id)
          }, 3000) // Wait 3 seconds for features event before trying fallback
        }
      })

      // Listen for device access errors
      const accessErrorUnsubscribe = listen<{
        deviceId: string
        error: string
        errorType: string
        status: string
      }>('device:access-error', (event) => {
        console.log('Device access error received:', event.payload)
        // Clear any pending dialogs when there's an access error
        setShowBootloaderUpdate(false)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
        setDeviceStatus(null)
        setConnectedDeviceId(null)
      })

      // Listen for device invalid state (timeout) errors
      const invalidStateUnsubscribe = listen<{
        deviceId: string
        error: string
        errorType: string
        status: string
      }>('device:invalid-state', (event) => {
        deviceLogger.logEvent('received', 'device:invalid-state', event.payload);
        deviceLogger.warn(LogCategory.DEVICE_CONNECTION, 'Device invalid state detected', {
          deviceId: event.payload.deviceId,
          error: event.payload.error,
          errorType: event.payload.errorType,
          currentDeviceId: connectedDeviceId,
          persistentDeviceId,
          setupWizardActive: setupWizardActive.current,
          setupInProgress,
          showWalletCreation,
          firmwareUpdateInProgress: firmwareUpdateInProgress.current
        });
        console.log('⏱️ Device invalid state detected:', event.payload)
        
        // CRITICAL: If setup is in progress, IGNORE invalid state errors
        // This happens during firmware updates when device reboots
        if (setupWizardActive.current || setupInProgress || showWalletCreation || firmwareUpdateInProgress.current) {
          deviceLogger.info(LogCategory.DEVICE_CONNECTION, 'Ignoring invalid state during setup - device may be rebooting', {
            protectionFlags: {
              setupWizardActive: setupWizardActive.current,
              setupInProgress,
              showWalletCreation,
              firmwareUpdateInProgress: firmwareUpdateInProgress.current
            }
          });
          console.log('🛡️🛡️ IGNORING invalid state during setup - device is rebooting')
          console.log('🛡️ Setup/Update must continue, not showing invalid state dialog')
          console.log('🛡️ Protection flags:', {
            setupWizardActive: setupWizardActive.current,
            setupInProgress,
            showWalletCreation,
            firmwareUpdateInProgress: firmwareUpdateInProgress.current
          })
          return; // Exit early - don't show dialog or clear state during setup
        }
        
        // Only clear dialogs if setup is NOT in progress
        setShowBootloaderUpdate(false)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
        setShowEnterBootloaderMode(false)
        setShowPinUnlock(false)  // This is crucial to prevent overlapping
        
        // Clear device status to prevent any further state updates
        setDeviceStatus(null)
        
        // Show the simple invalid state dialog
        deviceInvalidStateDialog.show({
          deviceId: event.payload.deviceId,
          error: event.payload.error,
          onDialogClose: () => {
            console.log('Invalid state dialog closed - user should reconnect device')
            // Device status will be updated when device reconnects
          }
        })
      })

      // Listen for PIN unlock needed events
      const pinUnlockUnsubscribe = listen<{
        deviceId: string
        features: DeviceFeatures
        status: DeviceStatus
        needsPinUnlock: boolean
      }>('device:pin-unlock-needed', async (event) => {
        console.log('🔒 DeviceUpdateManager: PIN unlock needed event received:', event.payload)
        const { status } = event.payload
        
        // CRITICAL: Hide any invalid state dialogs first - PIN has priority
        if (deviceInvalidStateDialog.isShowing(status.deviceId)) {
          console.log('🔒 Hiding invalid state dialog to show PIN dialog')
          deviceInvalidStateDialog.hide(status.deviceId)
        }
        
        // Verify device is actually ready for PIN operations before proceeding
        try {
          const isPinReady = await invoke('check_device_pin_ready', { deviceId: status.deviceId })
          
          if (isPinReady) {
            console.log('🔒 DeviceUpdateManager: Device confirmed ready for PIN, deferring UI to DialogContext handler')
            setDeviceStatus(status)
            setConnectedDeviceId(status.deviceId)
            setShowEnterBootloaderMode(false)
            setShowBootloaderUpdate(false)
            setShowFirmwareUpdate(false)
            setShowWalletCreation(false)
            // DO NOT render inline PinUnlockDialog here; WalletContext shows centralized PIN dialog
          } else {
            console.log('🔒 DeviceUpdateManager: Device not ready for PIN unlock, waiting...')
            // Device may not be ready yet, wait for next status update
          }
        } catch (error) {
          console.error('🔒 DeviceUpdateManager: Failed to check PIN readiness:', error)
          // Fallback: still update status but DO NOT open a second PIN dialog here
          setDeviceStatus(status)
          setConnectedDeviceId(status.deviceId)
          setShowEnterBootloaderMode(false)
          setShowBootloaderUpdate(false)
          setShowFirmwareUpdate(false)
          setShowWalletCreation(false)
        }
      })

      // NOTE: PIN request handling has been moved to WalletContext to avoid duplicate dialogs
      // WalletContext already listens for 'device:pin-request-triggered' and shows the PIN dialog
      // Keeping this commented out to prevent race conditions and duplicate PIN dialogs
      
      // const pinRequestTriggeredUnsubscribe = listen<{
      //   deviceId: string
      //   requestType: string
      //   needsPinEntry: boolean
      // }>('device:pin-request-triggered', async (event) => {
      //   console.log('🔒 DeviceUpdateManager: PIN request triggered event received:', event.payload)
      //   const { deviceId } = event.payload
      //   
      //   // Get current device status
      //   try {
      //     const currentStatus = await invoke('get_device_status', { deviceId })
      //     
      //     // Show PIN unlock dialog
      //     console.log('🔒 DeviceUpdateManager: Showing PIN unlock dialog after PIN request triggered')
      //     setDeviceStatus(currentStatus)
      //     setConnectedDeviceId(deviceId)
      //     setShowEnterBootloaderMode(false)
      //     setShowBootloaderUpdate(false)
      //     setShowFirmwareUpdate(false)
      //     setShowWalletCreation(false)
      //     setShowPinUnlock(true)
      //   } catch (error) {
      //     console.error('🔒 DeviceUpdateManager: Failed to get device status after PIN trigger:', error)
      //   }
      // })

      // Listen for passphrase unlock needed events from backend
      const passphraseUnlockUnsubscribe = listen<{
        deviceId: string
        features: DeviceFeatures
        status: DeviceStatus
        needsPassphraseUnlock: boolean
      }>('device:passphrase-unlock-needed', async (event) => {
        console.log('🔐 DeviceUpdateManager: Passphrase unlock needed event received:', event.payload)
        const deviceId = event.payload.deviceId
        
        // CRITICAL: Hide any invalid state dialogs first - passphrase has priority
        if (deviceInvalidStateDialog.isShowing(deviceId)) {
          console.log('🔐 Hiding invalid state dialog to show passphrase dialog')
          deviceInvalidStateDialog.hide(deviceId)
        }
        
        // Get the status from the event
        const { status } = event.payload
        console.log('🔐 DeviceUpdateManager: Device status when passphrase requested:', status)
        
        // Show passphrase unlock - this should trigger the passphrase request flow
        console.log('🔐 DeviceUpdateManager: Device needs passphrase')
        setDeviceStatus(status)
        setConnectedDeviceId(deviceId)
        setShowEnterBootloaderMode(false)
        setShowBootloaderUpdate(false)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
        setShowPinUnlock(false)
        
        // Show the unified auth dialog for PIN and/or passphrase
        // The dialog will handle checking if PIN is needed first
        if (!authDialog.isShowing(deviceId)) {
          console.log('🔐 DeviceUpdateManager: Showing unified auth dialog for device:', deviceId)
          authDialog.show({
            deviceId: deviceId,
            operationType: 'unlock',
            onComplete: () => {
              console.log('🔐 DeviceUpdateManager: Device authenticated successfully')
              // Device is now unlocked, refresh the portfolio
              if (refreshPortfolio) {
                refreshPortfolio()
              }
            }
          })
        } else {
          console.log('🔐 DeviceUpdateManager: Auth dialog already showing for device:', deviceId)
        }
      })

      // Listen for bootloader detection event
      const bootloaderDetectedUnsubscribe = listen<{
        deviceId: string
        isBootloader: boolean
        message: string
      }>('device:bootloader-detected', (event) => {
        console.log('🔧 Bootloader detected event received:', event.payload)
        const { deviceId, isBootloader, message } = event.payload
        
        if (isBootloader) {
          console.log('🔧 Device is in bootloader/updater mode - showing firmware update dialog')
          
          // Clear other dialogs
          setShowEnterBootloaderMode(false)
          setShowBootloaderUpdate(false)
          setShowWalletCreation(false)
          setShowPinUnlock(false)
          
          // Create a minimal device status for firmware update
          const bootloaderStatus: DeviceStatus = {
            deviceId: deviceId,
            connected: true,
            needsFirmwareUpdate: true,
            needsBootloaderUpdate: false,
            needsInitialization: false,
            needsPinUnlock: false,
            firmwareCheck: {
              currentVersion: 'Unknown',
              latestVersion: '7.10.0',
              needsUpdate: true
            },
            features: {
              bootloader_mode: true,
              bootloaderMode: true,
              initialized: false
            } as DeviceFeatures
          }
          
          setDeviceStatus(bootloaderStatus)
          setConnectedDeviceId(deviceId)
          setShowFirmwareUpdate(true)
        } else {
          // Guard: if backend sent non-bootloader event, ensure we don't show firmware dialog
          console.log('🔧 Bootloader detection event indicates NOT in bootloader; suppress firmware dialog')
          setShowFirmwareUpdate(false)
        }
      })

      // Listen for device disconnection
      const disconnectedUnsubscribe = listen<string>('device:disconnected', (event) => {
        const disconnectedDeviceId = event.payload;
        console.log('Device disconnected:', disconnectedDeviceId)
        
        // Clear PIN trigger tracking for disconnected device
        if (disconnectedDeviceId) {
          pinTriggeredForDevice.current.delete(disconnectedDeviceId)
          console.log('🔐 Cleared PIN trigger tracking for disconnected device:', disconnectedDeviceId)
        }
        
        // Check if recovery is in progress - if so, ignore disconnection events
        if ((window as any).KEEPKEY_RECOVERY_IN_PROGRESS) {
          console.log('🛡️ DeviceUpdateManager: Recovery in progress - IGNORING disconnection event')
          console.log('🛡️ DeviceUpdateManager: Keeping current state to protect recovery')
          return; // Don't change state during recovery
        }
        
        // CRITICAL: Check if setup is in progress
        // If setup wizard is active or in progress, DON'T clear any state
        if (setupWizardActive.current || setupInProgress) {
          console.log('🛡️🛡️ DeviceUpdateManager: SETUP IN PROGRESS - PRESERVING ALL STATE')
          console.log('🛡️ Setup wizard must NOT be abandoned during device disconnect')
          console.log('🛡️ Keeping wizard visible and waiting for device reconnection')
          
          // Keep the device ID for when it reconnects
          // Don't clear ANY state that would close the setup wizard
          return; // Exit early - preserve everything
        }
        
        // Only clear state if setup is NOT in progress
        console.log('DeviceUpdateManager: No setup in progress, clearing state normally')
        setDeviceStatus(null)
        setConnectedDeviceId(null)
        setShowBootloaderUpdate(false)
        setShowFirmwareUpdate(false)
        setShowWalletCreation(false)
        setShowPinUnlock(false)
        setRetryCount(0)
        if (timeoutId) clearTimeout(timeoutId)
        
        // Also hide the invalid state dialog if it's showing for this device
        if (deviceInvalidStateDialog.isShowing(disconnectedDeviceId)) {
          console.log('🔌 Hiding invalid state dialog for disconnected device')
          deviceInvalidStateDialog.hide(disconnectedDeviceId)
        }
      })

      // Frontend ready signal is now sent by App.tsx during initial setup

      return async () => {
        if (featuresUnsubscribe) (await featuresUnsubscribe)()
        if (connectedUnsubscribe) (await connectedUnsubscribe)()
        ;(await accessErrorUnsubscribe)()
        ;(await invalidStateUnsubscribe)()
        ;(await pinUnlockUnsubscribe)()
        // pinRequestTriggeredUnsubscribe is commented out to prevent duplicate PIN dialogs
        // ;(await pinRequestTriggeredUnsubscribe)()
        ;(await passphraseUnlockUnsubscribe)()
        ;(await bootloaderDetectedUnsubscribe)()
        ;(await disconnectedUnsubscribe)()
        if (timeoutId) clearTimeout(timeoutId)
      }
    }

    setupListeners()

    return () => {
      // Cleanup function will be called automatically
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [onComplete, setupInProgress, deviceInvalidStateDialog, onSetupWizardActiveChange, refreshPortfolio, fetchedXpubs])

  const handleFirmwareUpdate = async () => {
    setIsProcessing(true)
    try {
      // Update firmware using our implemented Tauri command
      await invoke('update_device_firmware', { 
        deviceId: deviceStatus?.deviceId,
        targetVersion: deviceStatus?.firmwareCheck?.latestVersion || ''
      })
      
      // After successful update, check if initialization is needed
      setShowFirmwareUpdate(false)
    } catch (error) {
      console.error('Firmware update failed:', error)
      // TODO: Show error dialog
    } finally {
      setIsProcessing(false)
    }
  }

  const handleFirmwareSkip = () => {
    setShowFirmwareUpdate(false)
    
    // Check if we need to show wallet creation
    if (deviceStatus?.needsInitialization) {
      setShowWalletCreation(true)
    } else {
      onComplete?.()
    }
  }

  const handleFirmwareRemindLater = () => {
    // TODO: Store reminder preference
    setShowFirmwareUpdate(false)
    
    // Continue to next step
    if (deviceStatus?.needsInitialization) {
      setShowWalletCreation(true)
    } else {
      onComplete?.()
    }
  }

  const handleWalletCreationComplete = () => {
    console.log('✅ Setup wizard completed successfully')
    setShowWalletCreation(false)
    setupWizardActive.current = false
    setupWizardDeviceId.current = null
    setPersistentDeviceId(null) // Clear persistent device ID
    setSetupInProgress(false) // Clear the setup in progress flag
    onSetupWizardActiveChange?.(false)
    onComplete?.()
  }

  const handleEnterBootloaderModeClose = () => {
    setShowEnterBootloaderMode(false)
    // Don't call onComplete here - wait for user to actually enter bootloader mode
  }

  const handlePinUnlocked = async () => {
    console.log('🔒 PIN unlock successful, device is now unlocked')
    console.log('🔒 Current dialog states:', {
      showPinUnlock,
      showBootloaderUpdate,
      showFirmwareUpdate,
      showWalletCreation,
      showEnterBootloaderMode
    })
    console.log('🔒 Device status after PIN unlock:', {
      needsFirmwareUpdate: deviceStatus?.needsFirmwareUpdate,
      needsBootloaderUpdate: deviceStatus?.needsBootloaderUpdate,
      needsInitialization: deviceStatus?.needsInitialization,
      firmwareVersion: deviceStatus?.firmwareCheck?.currentVersion,
      latestVersion: deviceStatus?.firmwareCheck?.latestVersion
    })
    
    setShowPinUnlock(false)
    
    // CRITICAL: Check if device still needs updates after PIN unlock
    if (deviceStatus?.needsFirmwareUpdate) {
      console.log('🔒 Device needs firmware update after PIN unlock - NOT calling onComplete')
      console.log('🔒 Firmware update needed: v' + deviceStatus.firmwareCheck?.currentVersion + ' -> v' + deviceStatus.firmwareCheck?.latestVersion)
      
      // Check if device is in bootloader mode
      const isInBootloaderMode = deviceStatus?.features?.bootloader_mode || deviceStatus?.features?.bootloaderMode || false
      
      if (!isInBootloaderMode) {
        // Device needs to enter bootloader mode first
        console.log('🔒 Showing enter bootloader mode dialog for firmware update')
        setShowEnterBootloaderMode(true)
        setShowFirmwareUpdate(false)
      } else {
        // Device is in bootloader mode, show firmware update
        console.log('🔒 Showing firmware update dialog')
        setShowEnterBootloaderMode(false)
        setShowFirmwareUpdate(true)
      }
      
      // DON'T call onComplete - device needs updates first
      return
    }
    
    // Only proceed with portfolio loading if device doesn't need updates
    try {
      console.log('🔄 Auto-loading portfolio after PIN unlock...')
      console.log(`📋 Current XPUBs in memory: ${fetchedXpubs.length}`)
      
      // Trigger portfolio refresh - this will automatically fetch XPUBs if needed
      await refreshPortfolio()
      console.log('✅ Portfolio loading initiated successfully')
      
    } catch (error) {
      console.error('❌ Failed to auto-load portfolio after PIN unlock:', error)
      // Don't block onComplete - user can manually refresh later
    }
    
    // Device should now be ready to use (no updates needed)
    console.log('🔒 Device fully ready after PIN unlock - calling onComplete')
    onComplete?.()
  }

  const handlePinUnlockClose = () => {
    setShowPinUnlock(false)
    // Don't call onComplete - user cancelled PIN entry
  }

  // Don't render anything during onboarding - this prevents device dialogs from interrupting
  if (onboardingInProgress) {
    console.log('🚪 DeviceUpdateManager: Onboarding in progress - not rendering device dialogs')
    return null
  }

  // If setup wizard is active, we should still render it even without deviceStatus
  if (!deviceStatus && !setupWizardActive.current && !persistentDeviceId) {
    console.log('🔧 DeviceUpdateManager: No deviceStatus, no active wizard, and no persistentDeviceId, returning null')
    return null
  }

  console.log('🔧 DeviceUpdateManager: Rendering with state:', {
    showWalletCreation,
    showFirmwareUpdate,
    showBootloaderUpdate,
    showEnterBootloaderMode,
    showPinUnlock,
    deviceStatus: deviceStatus?.needsInitialization,
    persistentDeviceId,
    setupWizardActive: setupWizardActive.current
  })

  return (
    <>
      {showEnterBootloaderMode && deviceStatus?.bootloaderCheck && deviceStatus?.deviceId && (
        <EnterBootloaderModeDialog
          isOpen={showEnterBootloaderMode}
          bootloaderCheck={deviceStatus.bootloaderCheck}
          deviceId={deviceStatus.deviceId}
          onClose={handleEnterBootloaderModeClose}
          isInitialized={deviceStatus?.features?.initialized === true}
          onSkip={() => {
            console.log('🔧 User skipped bootloader update')
            setShowEnterBootloaderMode(false)
            // Device is ready (PIN was already handled before showing this dialog)
            console.log('✅ Device is ready after user skipped bootloader update')
            onComplete?.()
          }}
        />
      )}

      {showBootloaderUpdate && deviceStatus?.bootloaderCheck && deviceStatus?.deviceId && (
        <BootloaderUpdateDialog
          isOpen={showBootloaderUpdate}
          bootloaderCheck={deviceStatus.bootloaderCheck}
          deviceId={deviceStatus.deviceId}
          onUpdateComplete={() => {
            setShowBootloaderUpdate(false)
            // The device will restart and emit new features
          }}
        />
      )}

      {showFirmwareUpdate && deviceStatus && (
        <FirmwareUpdateDialog
          isOpen={showFirmwareUpdate}
          firmwareCheck={deviceStatus.firmwareCheck || {
            currentVersion: 'Unknown',
            latestVersion: '7.10.0',
            needsUpdate: true
          }}
          deviceStatus={deviceStatus}
          onUpdateStart={handleFirmwareUpdate}
          onSkip={handleFirmwareSkip}
          onRemindLater={handleFirmwareRemindLater}
          onClose={() => setShowFirmwareUpdate(false)}
          isLoading={isProcessing}
        />
      )}

      {showWalletCreation && (persistentDeviceId || deviceStatus?.deviceId) && (
        <ErrorBoundary componentName="SetupWizard">
          <SetupWizard
            deviceId={persistentDeviceId || deviceStatus?.deviceId || ''}
            onComplete={handleWalletCreationComplete}
            onClose={() => {
              // NOTE: onClose should only be called when user explicitly cancels
              // NOT when device disconnects
              console.log('⚠️ SetupWizard onClose called - user cancelled setup')
              setShowWalletCreation(false)
              setupWizardActive.current = false
              setupWizardDeviceId.current = null
              setPersistentDeviceId(null)
              setSetupInProgress(false) // Clear setup in progress only on explicit close
              firmwareUpdateInProgress.current = false // Also clear firmware update flag
              onSetupWizardActiveChange?.(false)
            }}
            onFirmwareUpdateStart={() => {
              console.log('🔄 Firmware update starting in setup wizard')
              firmwareUpdateInProgress.current = true
            }}
            onFirmwareUpdateComplete={() => {
              console.log('✅ Firmware update complete in setup wizard')
              firmwareUpdateInProgress.current = false
            }}
          />
        </ErrorBoundary>
      )}

      {/* PinUnlockDialog is centrally managed by DialogContext via WalletContext events */}
    </>
  )
} 