import { useState, useEffect } from "react";
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import "./App.css";
import { Box, Text, Flex, Spinner } from "@chakra-ui/react";

import { Logo } from './components/logo/logo';
import splashBg from './assets/splash-bg.png'
import { EllipsisDots } from "./components/EllipsisSpinner";
import { SettingsDialog, SettingsButton } from './components/SettingsDialog';
import { useCommonDialogs } from './hooks/useCommonDialogs';
import { DeviceUpdateManager } from './components/DeviceUpdateManager';
import { useOnboardingState } from './hooks/useOnboardingState';
import { VaultInterface } from './components/VaultInterface';
import { useWallet } from './contexts/WalletContext';
import { useDialog } from './contexts/DialogContext';
import { useDeviceInteraction } from './hooks/useDeviceInteraction';
import { OnboardingGateProvider, useOnboardingGate } from './contexts/OnboardingGateContext';
import { DebugPanel } from './components/DebugPanel';

// Define the expected structure of DeviceFeatures from Rust
interface DeviceFeatures {
    label: string | null;
    vendor: string | null;
    model: string | null;
    firmware_variant: string | null;
    device_id: string | null;
    language: string | null;
    bootloader_mode: boolean;
    version: string;
    firmware_hash: string | null;
    bootloader_hash: string | null;
    initialized: boolean;
    imported: boolean | null;
    no_backup: boolean;
    pin_protection: boolean;
    pin_cached: boolean;
    passphrase_protection: boolean;
    passphrase_cached: boolean;
    wipe_code_protection: boolean;
    auto_lock_delay_ms: number | null;
    policies: string[];
}

interface DeviceInfoState {
    features: DeviceFeatures | null;
    error: string | null;
}

function App() {
    // AppContent is an inner component with access to DialogContext and OnboardingGate
    const AppContent = () => {
        // We're tracking application state from backend events
        const [loadingStatus, setLoadingStatus] = useState<string>('Starting...');
        const [deviceConnected, setDeviceConnected] = useState<boolean>(false);
        const [, setDeviceInfo] = useState<DeviceInfoState | null>(null);
        const [isSettingsOpen, setIsSettingsOpen] = useState(false);
        const [isRestarting, setIsRestarting] = useState(false);
        const [deviceUpdateComplete, setDeviceUpdateComplete] = useState(false);
        const [onboardingActive, setOnboardingActive] = useState(false);
        const [setupWizardActive, setSetupWizardActive] = useState(false);
        const [noDeviceDialogShown, setNoDeviceDialogShown] = useState(false);
        const { showOnboarding, showError, showNoDevice } = useCommonDialogs();
        const { shouldShowOnboarding, loading: onboardingLoading, clearCache } = useOnboardingState();
        const { hideAll, activeDialog, getQueue, isWizardActive } = useDialog();
        const { fetchedXpubs, portfolio, isSync, reinitialize } = useWallet();
        // Passphrase is now handled by unified auth dialog in useDeviceInteraction hook
        
        // Get onboarding gate state
        const { 
            allowDeviceInteractions, 
            onboardingInProgress, 
            queueDeviceEvent, 
            replayQueuedEvents,
            hasQueuedEvents 
        } = useOnboardingGate();
        
        // Enable global device interaction handling (PIN, passphrase, button dialogs)
        // But only if onboarding gate allows it
        useDeviceInteraction();
        
        // Check wallet context state and sync with local state
        useEffect(() => {
            console.log('📱 [App] Wallet context state check:', {
                portfolioPresent: !!portfolio,
                fetchedXpubsLength: fetchedXpubs.length,
                isSync,
                currentLocalState: {
                    loadingStatus,
                    deviceConnected,
                    deviceUpdateComplete
                }
            });
            
            // If wallet has xpubs and portfolio, ensure we show the vault
            if (fetchedXpubs.length > 0 && portfolio) {
                console.log('📱 [App] Wallet is ready with xpubs and portfolio, syncing local state');
                
                // Only update if not already set to avoid infinite loops
                if (!deviceConnected) {
                    console.log('📱 [App] Setting deviceConnected to true from wallet context');
                    setDeviceConnected(true);
                }
                if (!deviceUpdateComplete) {
                    console.log('📱 [App] Setting deviceUpdateComplete to true from wallet context');
                    setDeviceUpdateComplete(true);
                }
                if (loadingStatus !== 'Device ready') {
                    console.log('📱 [App] Setting loadingStatus to "Device ready" from wallet context');
                    setLoadingStatus('Device ready');
                }
            }
        }, [fetchedXpubs, portfolio, isSync, deviceConnected, deviceUpdateComplete, loadingStatus]);
        
        // Debug log active dialogs
        useEffect(() => {
            const queue = getQueue();
            if (activeDialog || queue.length > 0) {
                console.log('📱 [App] Active dialog:', activeDialog?.id);
                console.log('📱 [App] Dialog queue:', queue.map(d => d.id));
            }
        }, [activeDialog, getQueue]);
        
        // Clear any stuck dialogs when showing VaultInterface (but not passphrase dialogs)
        useEffect(() => {
            console.log('📱 [App] Dialog cleanup effect triggered with:', {
                loadingStatus,
                deviceConnected,
                deviceUpdateComplete,
                expectedLoadingStatus: "Device ready",
                statusMatches: loadingStatus === "Device ready",
                allConditionsMet: loadingStatus === "Device ready" && deviceConnected && deviceUpdateComplete
            });
            
            if (loadingStatus === "Device ready" && deviceConnected && deviceUpdateComplete) {
                // Add a longer delay to prevent race conditions with passphrase dialog showing
                const timeoutId = setTimeout(() => {
                    const queue = getQueue();
                    console.log('📱 [App] Dialog cleanup timeout fired! Queue length:', queue.length);
                    console.log('📱 [App] Current queue contents:', queue.map(d => ({ id: d.id, priority: d.priority })));
                    
                    // Check if any important dialogs are in the queue that shouldn't be cleared
                    const hasPassphraseDialog = queue.some(d => d.id.includes('passphrase'));
                    const hasPinDialog = queue.some(d => d.id.includes('pin'));
                    const hasFirmwareDialog = queue.some(d => d.id.includes('firmware-update'));
                    const hasBootloaderDialog = queue.some(d => d.id.includes('bootloader-update'));
                    
                    if (hasPassphraseDialog) {
                        console.log('📱 [App] ⚠️ Passphrase dialog detected - NOT clearing dialogs, blocking UI');
                    } else if (hasPinDialog) {
                        console.log('📱 [App] ⚠️ PIN dialog detected - NOT clearing dialogs, blocking UI');
                    } else if (hasFirmwareDialog) {
                        console.log('📱 [App] ⚠️ Firmware update dialog detected - NOT clearing dialogs');
                    } else if (hasBootloaderDialog) {
                        console.log('📱 [App] ⚠️ Bootloader update dialog detected - NOT clearing dialogs');
                    } else if (queue.length > 0) {
                        console.warn('📱 [App] 🧹 Clearing stuck dialogs before showing VaultInterface:', queue.map(d => d.id));
                        hideAll();
                    } else {
                        console.log('📱 [App] ✅ No stuck dialogs to clear');
                    }
                }, 500); // Longer delay to allow dialog to be added to queue
                
                return () => {
                    console.log('📱 [App] Cleaning up dialog cleanup timeout');
                    clearTimeout(timeoutId);
                };
            }
        }, [loadingStatus, deviceConnected, deviceUpdateComplete, getQueue, hideAll]);
        
        // Function to show device access error dialog
        const showDeviceAccessError = (errorMessage: string) => {
            showError("KeepKey Device Access Error", errorMessage);
        };
        
        // Function to restart backend startup process
        const handleLogoClick = async () => {
            if (isRestarting) return; // Prevent multiple clicks
            
            setIsRestarting(true);
            try {
                console.log("Logo clicked - restarting backend startup process");
                
                // Reset all frontend state to initial values
                console.log("Resetting frontend state...");
                setLoadingStatus('Starting...');
                setDeviceConnected(false);
                setDeviceInfo(null);
                setDeviceUpdateComplete(false);
                
                // Restart backend
                await invoke('restart_backend_startup');
                console.log("Backend restart initiated successfully");
                
                // Re-run wallet initialization to resubscribe device state after backend restart
                reinitialize();
                
                // Signal backend that frontend is ready again
                setTimeout(async () => {
                    try {
                        console.log('🎯 Re-signaling backend that frontend is ready after restart...');
                        await invoke('frontend_ready');
                        console.log('✅ Frontend ready signal sent successfully after restart');
                    } catch (error) {
                        console.log('frontend_ready command failed after restart:', error);
                    }
                }, 500);
            } catch (error) {
                console.error("Failed to restart backend startup:", error);
            } finally {
                // Reset the restarting flag after a delay
                setTimeout(() => setIsRestarting(false), 2000);
            }
        };

        // Check onboarding status on startup
        useEffect(() => {
            if (onboardingLoading) {
                console.log("App.tsx: Onboarding state still loading...");
                return;
            }

            console.log(`App.tsx: Should show onboarding: ${shouldShowOnboarding}, onboardingActive: ${onboardingActive}`);
            
            // Only show onboarding if needed AND not already active (prevent loops)
            if (shouldShowOnboarding && !onboardingActive) {
                console.log("App.tsx: Showing onboarding wizard");
                setOnboardingActive(true);
                // Add a small delay to ensure the dialog system is ready
                setTimeout(() => {
                    showOnboarding({
                        onComplete: () => {
                            console.log("App.tsx: Onboarding completed callback");
                            setOnboardingActive(false); // Mark as inactive first
                            clearCache(); // Clear the cache after completion
                        }
                    });
                }, 1000);
            } else {
                console.log("App.tsx: Onboarding not needed or already active");
            }
        }, [shouldShowOnboarding, onboardingLoading, onboardingActive, showOnboarding]);

        // Replay queued device events when device interactions become allowed
        useEffect(() => {
            if (allowDeviceInteractions && hasQueuedEvents) {
                console.log('🚪 OnboardingGate: Device interactions now allowed, replaying queued events');
                const queuedEvents = replayQueuedEvents();
                
                // Process queued events
                queuedEvents.forEach(async (queuedEvent) => {
                    console.log('🔄 Replaying queued event:', queuedEvent.type, queuedEvent.id);
                    
                    try {
                        switch (queuedEvent.type) {
                            case 'device:ready':
                                if (queuedEvent.payload.device && queuedEvent.payload.features) {
                                    console.log('🔄 Replaying device:ready - setting device state');
                                    setDeviceConnected(true);
                                    setDeviceInfo({ features: queuedEvent.payload.features, error: null });
                                    setDeviceUpdateComplete(true);
                                    setLoadingStatus('Device ready');
                                    console.log(`🔄 Device ready replayed: ${queuedEvent.payload.features.label || 'Unlabeled'} v${queuedEvent.payload.features.version}`);
                                }
                                break;
                                
                            case 'passphrase_request':
                                console.log('🔄 Replaying passphrase_request - will be handled by unified auth dialog');
                                // Passphrase is now handled by unified auth dialog
                                break;
                                
                            case 'device:awaiting_passphrase':
                                console.log('🔄 Replaying device:awaiting_passphrase - will be handled by useDeviceInteraction hook');
                                // This will be re-processed by useDeviceInteraction hook since allowDeviceInteractions is now true
                                break;
                                
                            default:
                                console.log('🔄 Unknown queued event type:', queuedEvent.type);
                        }
                    } catch (error) {
                        console.error('🔄 Error replaying queued event:', queuedEvent.type, error);
                    }
                });
                
                // Signal backend that frontend is ready and start device operations
                if (queuedEvents.length > 0) {
                    setTimeout(async () => {
                        try {
                            console.log('🔄 Signaling backend ready after replaying events...');
                            await invoke('frontend_ready');
                            console.log('🔄 Backend ready signal sent after replay');
                            
                            console.log('🔄 Starting device operations after replay...');
                            await invoke('start_device_operations');
                            console.log('🔄 Device operations started after replay');
                        } catch (error) {
                            console.log('🔄 Failed to start operations after replay:', error);
                        }
                    }, 500);
                }
            }
        }, [allowDeviceInteractions, hasQueuedEvents, replayQueuedEvents]);

        // Show "No Device" dialog after 30 seconds if no device is connected
        useEffect(() => {
            let timeoutId: NodeJS.Timeout;
            
            if (!deviceConnected && !noDeviceDialogShown && !onboardingActive && !setupWizardActive) {
                console.log("📱 [App] Starting 30-second timer for no device dialog");
                timeoutId = setTimeout(() => {
                    if (!deviceConnected) {
                        console.log("📱 [App] 30 seconds elapsed with no device - showing dialog");
                        setNoDeviceDialogShown(true);
                        showNoDevice({
                            onRetry: async () => {
                                console.log("📱 [App] User clicked retry - restarting backend");
                                setNoDeviceDialogShown(false);
                                // Restart the backend to scan for devices again
                                try {
                                    await invoke('restart_backend_startup');
                                    reinitialize();
                                } catch (error) {
                                    console.error("Failed to restart backend:", error);
                                }
                            }
                        });
                    }
                }, 30000); // 30 seconds
            } else if (deviceConnected && noDeviceDialogShown) {
                // Device connected, reset the flag
                setNoDeviceDialogShown(false);
            }
            
            return () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            };
        }, [deviceConnected, noDeviceDialogShown, onboardingActive, setupWizardActive, showNoDevice, reinitialize]);

        useEffect(() => {
            let unlistenStatusUpdate: (() => void) | undefined;
            let unlistenDeviceReady: (() => void) | undefined;
            let unlistenFeaturesUpdated: (() => void) | undefined;
            let unlistenAccessError: (() => void) | undefined;
            let unlistenDeviceDisconnected: (() => void) | undefined;
            // Passphrase requests are now handled by useDeviceInteraction hook
            let unlistenPassphraseSuccess: (() => void) | undefined;
            let unlistenNoDeviceFound: (() => void) | undefined;

            // Add keyboard listener for F12 to open devtools
            const handleKeyDown = (e: KeyboardEvent) => {
                if (e.key === 'F12' || (e.metaKey && e.altKey && e.key === 'i')) {
                    e.preventDefault();
                    invoke('open_devtools').catch(console.error);
                }
            };
            window.addEventListener('keydown', handleKeyDown);

            (async () => {
                try {
                    console.log('🎯 Setting up event listeners...');
                    console.log('🔐 [App] ***** APP IS RUNNING - CONSOLE LOGS WORKING *****');
                    
                    // Signal backend that frontend is ready to receive events FIRST
                    // But only if onboarding allows device interactions
                    if (allowDeviceInteractions) {
                        try {
                            console.log('🎯 Signaling backend that frontend is ready...');
                            await invoke('frontend_ready');
                            console.log('✅ Frontend ready signal sent successfully');
                        } catch (error) {
                            console.log('DeviceUpdateManager: frontend_ready command failed:', error);
                        }
                    } else {
                        console.log('🚪 OnboardingGate: Blocking frontend_ready signal - onboarding in progress');
                    }
                    
                    // Listen for status updates from backend
                    console.log('🎯 Setting up status:update listener...');
                    unlistenStatusUpdate = await listen('status:update', (event) => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        const payload = event.payload as any;
                        console.log('📱 [App] Frontend received status update:', payload);
                        
                        if (payload.status) {
                            console.log('📱 [App] Setting loading status from', loadingStatus, 'to:', payload.status);
                            setLoadingStatus(payload.status);
                            
                            // Special check for "Device ready" status
                            if (payload.status === 'Device ready') {
                                console.log('📱 [App] Received "Device ready" status! Current state:', {
                                    deviceConnected,
                                    deviceUpdateComplete
                                });
                            }
                        } else {
                            console.log('❌ No status field in payload:', payload);
                        }
                    });

                    // Listen for device ready events (device with features loaded and fully ready)
                    unlistenDeviceReady = await listen('device:ready', (event) => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        const payload = event.payload as any;
                        console.log('📱 [App] Device ready event received:', payload);
                        
                        if (!allowDeviceInteractions) {
                            console.log('🚪 OnboardingGate: Queueing device:ready event - onboarding in progress');
                            queueDeviceEvent({
                                id: `device-ready-${Date.now()}`,
                                type: 'device:ready',
                                payload,
                                timestamp: Date.now(),
                                deviceId: payload.device?.id || payload.features?.device_id
                            });
                            return;
                        }
                        
                        if (payload.device && payload.features) {
                            console.log('📱 [App] Setting deviceConnected to true from device:ready event');
                            setDeviceConnected(true);
                            setDeviceInfo({ features: payload.features, error: null });
                            console.log('📱 [App] Setting deviceUpdateComplete to true from device:ready event');
                            setDeviceUpdateComplete(true);
                            console.log('📱 [App] Setting loadingStatus to "Device ready" from device:ready event');
                            setLoadingStatus('Device ready');
                            console.log(`✅ Device ready: ${payload.features.label || 'Unlabeled'} v${payload.features.version}`);
                        }
                    });

                    // Listen for device features-updated events (includes status evaluation for DeviceUpdateManager)
                    unlistenFeaturesUpdated = await listen('device:features-updated', (event) => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        const payload = event.payload as any;
                        console.log('Device features-updated event received:', payload);
                        
                        if (payload.features) {
                            setDeviceConnected(true);
                            setDeviceInfo({ features: payload.features, error: null });
                            // Reset update completion state for new device connections
                            setDeviceUpdateComplete(false);
                        }
                    });

                    // Listen for device access errors from backend
                    unlistenAccessError = await listen('device:access-error', (event) => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        const errorData = event.payload as any;
                        console.log('Device access error event received:', errorData);
                        
                        showDeviceAccessError(errorData.error);
                        setLoadingStatus('Device busy');
                    });

                    // Listen for device disconnection events
                    unlistenDeviceDisconnected = await listen('device:disconnected', (event) => {
                        console.log('Device disconnected event received:', event.payload);
                        setDeviceConnected(false);
                        setDeviceInfo(null);
                        setDeviceUpdateComplete(false);
                    });

                    // REMOVED: Duplicate passphrase_request listener
                    // Passphrase requests are now handled by:
                    // 1. useDeviceInteraction hook for device:awaiting_passphrase events
                    // 2. Unified PinPassphraseDialog that handles both PIN and passphrase in sequence
                    console.log('🔐 [App] Passphrase handling delegated to useDeviceInteraction and unified auth dialog');

                    // Listen for passphrase success event to close the modal
                    unlistenPassphraseSuccess = await listen('passphrase:success', async (event) => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        const payload = event.payload as any;
                        console.log('🔐 [App] Passphrase success received:', payload);
                        
                        // Close the passphrase dialog for this device
                        if (payload.deviceId) {
                            // Passphrase dialog is now part of unified auth dialog
                            console.log('🔐 [App] Passphrase success - handled by unified auth dialog');
                        } else {
                            console.log('🔐 [App] Passphrase success - handled by unified auth dialog');
                        }
                        
                        // Auto-recovery: If app seems stuck after passphrase, reinitialize after delay
                        console.log('🔐 [App] Starting auto-recovery timer after passphrase success...');
                        
                        // First attempt: Quick check and try to reinitialize
                        setTimeout(async () => {
                            try {
                                // Check if we're still stuck (loading status not progressed)
                                if (loadingStatus === 'Scanning for devices...' || loadingStatus === 'Initializing app...') {
                                    console.log('🔄 [App] Auto-recovery: App appears stuck after passphrase, reinitializing...');
                                    console.log('🔄 [App] Current loading status:', loadingStatus);
                                    
                                    // Trigger frontend ready to re-establish device connection
                                    await invoke('frontend_ready');
                                    console.log('🔄 [App] Auto-recovery: Frontend ready sent');
                                    
                                    // Also try to get device status to trigger initialization
                                    try {
                                        await invoke('get_connected_devices_with_features');
                                        console.log('🔄 [App] Auto-recovery: Device query sent');
                                    } catch (e) {
                                        console.log('🔄 [App] Auto-recovery: Device query failed:', e);
                                    }
                                }
                            } catch (error) {
                                console.error('🔄 [App] Auto-recovery first attempt failed:', error);
                            }
                        }, 1500);
                        
                        // Second attempt: More aggressive restart if still stuck
                        setTimeout(async () => {
                            try {
                                if (!deviceConnected || loadingStatus === 'Scanning for devices...' || loadingStatus === 'Initializing app...') {
                                    console.log('🔄 [App] Auto-recovery: Still stuck after 5 seconds, performing backend restart...');
                                    console.log('🔄 [App] Device connected:', deviceConnected, 'Loading status:', loadingStatus);
                                    await invoke('restart_backend_startup');
                                    console.log('🔄 [App] Auto-recovery: Backend restart initiated');
                                }
                            } catch (error) {
                                console.error('🔄 [App] Auto-recovery second attempt failed:', error);
                            }
                        }, 5000);
                    });

                    // Listen for "no device found" event from backend
                    unlistenNoDeviceFound = await listen('device:no-device-found', (event) => {
                        console.log('📱 [App] No device found event received from backend:', event.payload);
                        if (!deviceConnected && !noDeviceDialogShown) {
                            setNoDeviceDialogShown(true);
                            showNoDevice({
                                onRetry: async () => {
                                    console.log('📱 [App] User clicked retry - restarting backend');
                                    setNoDeviceDialogShown(false);
                                    // Restart the backend to scan for devices again
                                    try {
                                        await invoke('restart_backend_startup');
                                        reinitialize();
                                    } catch (error) {
                                        console.error('Failed to restart backend:', error);
                                    }
                                }
                            });
                        }
                    });

                    console.log('✅ All event listeners set up successfully');
                } catch (error) {
                    console.error('Failed to set up event listeners:', error);
                }
            })();

            return () => {
                window.removeEventListener('keydown', handleKeyDown);
                if (unlistenStatusUpdate) unlistenStatusUpdate();
                if (unlistenDeviceReady) unlistenDeviceReady();
                if (unlistenFeaturesUpdated) unlistenFeaturesUpdated();
                if (unlistenAccessError) unlistenAccessError();
                if (unlistenDeviceDisconnected) unlistenDeviceDisconnected();
                // Passphrase listener removed - handled by useDeviceInteraction
                if (unlistenPassphraseSuccess) unlistenPassphraseSuccess();
                if (unlistenNoDeviceFound) unlistenNoDeviceFound();
            };
        }, [allowDeviceInteractions]);

        const mcpUrl = "http://127.0.0.1:1646/mcp";

        // Show the main vault interface ONLY when device is ready AND updates are complete AND no passphrase dialog
        const queue = getQueue();
        const hasPassphraseDialog = queue.some(d => d.id.includes('passphrase'));
        
        console.log('📱 [App] Checking if should show VaultInterface:', {
            loadingStatus,
            deviceConnected,
            deviceUpdateComplete,
            hasPassphraseDialog,
            shouldShow: loadingStatus === "Device ready" && deviceConnected && deviceUpdateComplete && !hasPassphraseDialog
        });
        
        if (loadingStatus === "Device ready" && deviceConnected && deviceUpdateComplete && !hasPassphraseDialog) {
            console.log('📱 [App] ✅ All conditions met - showing VaultInterface!');
            return <VaultInterface />;
        }

        // Show splash screen while connecting
        return (
          <Box
            height="100vh"
            width="100vw"
            position="relative"
            backgroundImage={`url(${splashBg})`}
            backgroundSize="cover"
            backgroundPosition="center"
          >
            <Flex 
              height="100%"
              width="100%"
              direction="column"
              alignItems="center"
              justifyContent="center"
            >
              {/* Clickable Logo in the center - hide when wizards are active */}
              {!onboardingActive && !isWizardActive() && !setupWizardActive && (
                <Logo 
                width="100px" 
                onClick={handleLogoClick}
                style={{
                  filter: isRestarting ? 'brightness(1.3)' : 'none',
                  transition: 'filter 0.2s ease'
                  }}
                />
              )}
              
              
              {/* Clickable hint */}
              <Text 
                fontSize="xs" 
                color="gray.400" 
                mt={2} 
                textAlign="center"
                opacity={isRestarting ? 0.5 : 0.7}
                transition="opacity 0.2s ease"
              >
                {isRestarting ? "Restarting..." : ""}
              </Text>
              
              {/* Loading text at the bottom */}
                <Box
                    position="absolute"
                    bottom="40px"
                    textAlign="center"
                    width="auto"
                    px={3}
                    py={1}
                    borderRadius="md"
                    bg="rgba(0, 0, 0, 0.5)"
                >
                    <Flex gap="2" justifyContent="center" alignItems="center" direction="column">
                        <Flex gap="2" justifyContent="center" alignItems="center">
                            <Spinner size="xs" color={deviceConnected ? "green.400" : "gray.400"} />
                            <Text fontSize="xs" color="gray.300">
                                {loadingStatus === "Scanning for devices..." && !deviceConnected 
                                    ? "Please connect your KeepKey" 
                                    : loadingStatus}
                            </Text>
                            <EllipsisDots interval={300} /> {/* ⟵ no layout shift */}
                        </Flex>
                        {loadingStatus === "Scanning for devices..." && !deviceConnected && (
                            <Text fontSize="xs" color="gray.400" mt={1}>
                                If your device is already connected, try unplugging and reconnecting it
                            </Text>
                        )}
                    </Flex>
                </Box>

              {/* Settings button in bottom left */}
              <SettingsButton onClick={() => setIsSettingsOpen(true)} />

              {/* Settings dialog */}
              <SettingsDialog 
                isOpen={isSettingsOpen} 
                onClose={() => setIsSettingsOpen(false)} 
              />

              {/* Device update manager - handles bootloader/firmware updates and wallet creation */}
              <DeviceUpdateManager 
                onComplete={() => {
                  console.log('📱 [App] DeviceUpdateManager onComplete callback triggered');
                  console.log('📱 [App] Current state before updates:', {
                    deviceUpdateComplete,
                    loadingStatus,
                    deviceConnected
                  });
                  console.log('📱 [App] Setting deviceUpdateComplete to true');
                  setDeviceUpdateComplete(true);
                  console.log('📱 [App] Setting loadingStatus to "Device ready"');
                  setLoadingStatus('Device ready');
                  // Also ensure deviceConnected is true if not already
                  if (!deviceConnected) {
                    console.log('📱 [App] Also setting deviceConnected to true from onComplete');
                    setDeviceConnected(true);
                  }
                }}
                onSetupWizardActiveChange={setSetupWizardActive}
              />
              
              {/* Debug panel for logging (Ctrl+Shift+D to toggle) */}
              <DebugPanel />

              {/* REST and MCP links in bottom right corner */}
              {/*<Box*/}
              {/*  position="absolute"*/}
              {/*  bottom="20px"*/}
              {/*  right="20px"*/}
              {/*  background="rgba(0, 0, 0, 0.7)"*/}
              {/*  borderRadius="md"*/}
              {/*  boxShadow="md"*/}
              {/*  padding={2}*/}
              {/*  border="1px solid rgba(100, 255, 100, 0.3)"*/}
              {/*>*/}
              {/*  <Flex direction="column" gap={1}>*/}
              {/*    <Stack direction="row" gap={2} align="center">*/}
              {/*      <Text fontSize="2xs" color="gray.300">REST:</Text>*/}
              {/*      <Link */}
              {/*        href="http://127.0.0.1:1646/docs" */}
              {/*        target="_blank" */}
              {/*        fontSize="xs" */}
              {/*        color="blue.300"*/}
              {/*        _hover={{ color: "blue.200", textDecoration: "underline" }}*/}
              {/*      >*/}
              {/*        http://127.0.0.1:1646/docs*/}
              {/*      </Link>*/}
              {/*    </Stack>*/}
              {/*    <Stack direction="row" gap={2} align="center">*/}
              {/*      <Text fontSize="2xs" color="gray.300">MCP:</Text>*/}
              {/*      <Link */}
              {/*        href="http://127.0.0.1:1646/mcp" */}
              {/*        target="_blank" */}
              {/*        fontSize="xs" */}
              {/*        color="blue.300"*/}
              {/*        _hover={{ color: "blue.200", textDecoration: "underline" }}*/}
              {/*      >*/}
              {/*        http://127.0.0.1:1646/mcp*/}
              {/*      </Link>*/}
              {/*      <Box position="relative">*/}
              {/*        <Button*/}
              {/*          size="xs"*/}
              {/*          variant="ghost"*/}
              {/*          colorScheme={hasCopied ? "green" : "blue"}*/}
              {/*          aria-label="Copy MCP URL to clipboard"*/}
              {/*          title={hasCopied ? "Copied!" : "Copy to clipboard"}*/}
              {/*          onClick={handleCopy}*/}
              {/*          p={1}*/}
              {/*          minW={0}*/}
              {/*          height="16px"*/}
              {/*        >*/}
              {/*          {hasCopied ? <FaCheck size="10px" /> : <FaCopy size="10px" />}*/}
              {/*        </Button>*/}
              {/*      </Box>*/}
              {/*    </Stack>*/}
              {/*  </Flex>*/}
              {/*</Box>*/}
            </Flex>
          </Box>
        );
    };

    return (
        <OnboardingGateProvider>
            <AppContent />
        </OnboardingGateProvider>
    );
}

export default App;
