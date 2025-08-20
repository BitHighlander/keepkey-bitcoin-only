import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Text,
  Flex,
  Spinner,
  Switch,
  Button,
  HStack,
} from '@chakra-ui/react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { usePinPassphraseDialog } from '../contexts/DialogContext';

interface PassphraseSettingsProps {
  deviceId: string;
  isPassphraseEnabled?: boolean;
  onPassphraseToggle?: (enabled: boolean) => void;
}

export const PassphraseSettings: React.FC<PassphraseSettingsProps> = ({
  deviceId,
  isPassphraseEnabled: initialEnabled = false,
  onPassphraseToggle,
}) => {
  const [isEnabled, setIsEnabled] = useState(initialEnabled);
  const [isUpdating, setIsUpdating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const authDialog = usePinPassphraseDialog();
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  
  console.log('[PassphraseSettings] Component rendered - deviceId:', deviceId, 'isEnabled:', isEnabled, 'isUpdating:', isUpdating);

  // Debug log the initial prop value
  console.log(`[PassphraseSettings] Component mounted/updated - deviceId: ${deviceId}, initialEnabled prop: ${initialEnabled}`);
  
  // Initialize device interaction state on mount - but only if needed
  useEffect(() => {
    const checkAndInitializeDeviceState = async () => {
      try {
        // First check if device is stuck
        const currentState = await invoke<string>('get_device_interaction_state', { deviceId });
        console.log(`[PassphraseSettings] Device ${deviceId} initial state: ${currentState}`);
        
        // Only reset if device is stuck in a bad state (not Idle and not actively processing)
        if (currentState && 
            currentState !== 'No session found (Idle)' && 
            currentState !== 'Idle' &&
            !currentState.includes('Awaiting')) {
          console.log(`[PassphraseSettings] Device seems stuck in ${currentState}, resetting to Idle`);
          await invoke('reset_device_interaction_state', { deviceId });
        }
      } catch (error) {
        console.error('[PassphraseSettings] Failed to check/initialize device state:', error);
      }
    };
    
    checkAndInitializeDeviceState();
  }, [deviceId]);

  // Sync local state with device features state
  useEffect(() => {
    console.log(`[PassphraseSettings] Syncing state - initialEnabled changed to: ${initialEnabled}`);
    setIsEnabled(initialEnabled);
  }, [initialEnabled]);

  // Log passphrase protection status changes for debugging
  useEffect(() => {
    console.log(`[PassphraseSettings] Device ${deviceId} - passphrase protection state: ${isEnabled ? 'enabled' : 'disabled'}`);
  }, [isEnabled, deviceId]);

  // Listen for device events
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    // Listen for PIN requests for settings changes
    const setupPinListener = async () => {
      console.log('[PassphraseSettings] Setting up PIN listener for device:', deviceId);
      const unlisten = await listen<{
        device_id: string;
        request_id: string;
        kind: string;
      }>('device:awaiting_pin', (event) => {
        console.log('[PassphraseSettings] device:awaiting_pin event received:', event.payload);
        if (event.payload.device_id === deviceId && event.payload.kind === 'settings') {
          console.log('[PassphraseSettings] Event matches our device and is for settings!');
          setStatusMessage('Please enter your PIN to change passphrase settings.');
          // Show the PIN dialog
          console.log('[PassphraseSettings] Showing PIN dialog for settings change');
          authDialog.show({
            deviceId: deviceId,
            operationType: 'settings',
            onComplete: () => {
              console.log('[PassphraseSettings] PIN entry completed');
              setStatusMessage('PIN accepted, applying changes...');
            },
          });
        }
      });
      unlisteners.push(unlisten);
    };

    // Listen for device reconnection needs
    const setupReconnectListener = async () => {
      const unlisten = await listen<{
        device_id: string;
        reason: string;
      }>('device:needs_reconnect', (event) => {
        if (event.payload.device_id === deviceId) {
          const reason = event.payload.reason;
          if (reason.includes('Passphrase')) {
            setStatusMessage('Please unplug and reconnect your KeepKey to apply the passphrase changes.');
            setIsUpdating(false);
          }
        }
      });
      unlisteners.push(unlisten);
    };

    // Listen for device reconnection
    const setupConnectedListener = async () => {
      const unlisten = await listen<{
        device_id: string;
      }>('device:connected', (event) => {
        if (event.payload.device_id === deviceId) {
          setStatusMessage('Device reconnected successfully!');
          setTimeout(() => setStatusMessage(null), 2000);
          
          // Now that device is reconnected, notify parent to refresh
          if (onPassphraseToggle) {
            console.log('[PassphraseSettings] Device reconnected, notifying parent to refresh');
            onPassphraseToggle(isEnabled);
          }
        }
      });
      unlisteners.push(unlisten);
    };

    // Setup all listeners
    setupPinListener();
    setupReconnectListener();
    setupConnectedListener();

    // Cleanup listeners on unmount
    return () => {
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [deviceId]);

  const handleTogglePassphrase = async () => {
    if (isUpdating) return;
    
    const newState = !isEnabled;
    setIsUpdating(true);
    
    // Add a debug log to confirm we're entering the function
    console.log('[PassphraseSettings] handleTogglePassphrase called, newState:', newState);
    
    if (newState) {
      // Show info about the flow
      setStatusMessage('Press and hold the button on your KeepKey to confirm enabling passphrase protection.');
      
      // Just a small delay to ensure any listeners are ready
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    try {
      // First check device interaction state
      const currentState = await invoke<string>('get_device_interaction_state', { deviceId });
      console.log(`[PassphraseSettings] Current device interaction state: ${currentState}`);
      
      // If device is busy, try to reset it
      if (currentState !== 'No session found (Idle)' && currentState !== 'Idle') {
        console.log('[PassphraseSettings] Device is busy, attempting to reset state...');
        await invoke('reset_device_interaction_state', { deviceId });
        console.log('[PassphraseSettings] Device state reset to Idle');
        
        // Small delay to ensure state is settled
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Send the enable/disable command to the device using the v2 command
      console.log('[PassphraseSettings] Calling enable_passphrase_protection_v2');
      const response = await invoke('enable_passphrase_protection_v2', {
        deviceId,
        enabled: newState,
      });
      console.log('[PassphraseSettings] Backend response:', response);
      
      // Check device state immediately after the command
      const deviceState = await invoke<string>('get_device_interaction_state', { deviceId });
      console.log('[PassphraseSettings] Device state after command:', deviceState);
      
      // If device is awaiting PIN, show the dialog immediately
      if (deviceState.includes('AwaitingPIN')) {
        console.log('[PassphraseSettings] Device is awaiting PIN, showing dialog immediately');
        setStatusMessage('Please enter your PIN to change passphrase settings.');
        authDialog.show({
          deviceId: deviceId,
          operationType: 'settings',
          onComplete: () => {
            console.log('[PassphraseSettings] PIN entry completed');
            setStatusMessage('PIN accepted, applying changes...');
            // Update local state after PIN is accepted
            setIsEnabled(newState);
          },
        });
        // Don't update state yet - wait for PIN completion
        return;
      }
      
      // Update local state only if no PIN is needed
      setIsEnabled(newState);
      
      // Check if device is in PIN/interaction state before notifying parent
      const interactionState = await invoke<string>('get_device_interaction_state', { deviceId });
      console.log(`[PassphraseSettings] Device interaction state after operation: ${interactionState}`);
      
      // Only notify parent if device is not waiting for user interaction
      if (onPassphraseToggle && !interactionState.includes('AwaitingPIN') && !interactionState.includes('AwaitingButton')) {
        console.log('[PassphraseSettings] Device is idle, notifying parent to refresh');
        onPassphraseToggle(newState);
      } else if (interactionState.includes('AwaitingPIN') || interactionState.includes('AwaitingButton')) {
        console.log('[PassphraseSettings] Device is awaiting interaction, skipping parent notification to avoid interruption');
      }
      
      // Success message without restart
      if (newState) {
        setStatusMessage('Passphrase protection enabled successfully!');
      } else {
        setStatusMessage('Passphrase protection disabled successfully!');
      }
      
      // Clear status message after 3 seconds
      setTimeout(() => setStatusMessage(null), 3000);
      
      setIsUpdating(false);
    } catch (err) {
      console.error('[PassphraseSettings] Failed to update passphrase protection:', err);
      
      setStatusMessage(`Error: ${err instanceof Error ? err.message : 'Failed to update passphrase protection'}`);
      setTimeout(() => setStatusMessage(null), 5000);
      
      setIsUpdating(false);
      // Revert the switch on error (if we updated it prematurely)
      setIsEnabled(!newState);
    }
  };


  return (
    <Box p={4} borderWidth={1} borderRadius="md">
      <Flex direction="column" gap={4}>
          <Text fontSize="lg" fontWeight="bold">
            Passphrase Protection
          </Text>
          
          <Flex align="center" justify="space-between">
            <Flex direction="column">
              <Text fontWeight="medium">
                Enable Passphrase
              </Text>
              <Text fontSize="sm" color="gray.600">
                Enable the ability to have multiple wallets, accessible by using a unique passphrase for each wallet.
              </Text>
              {isEnabled && (
                <Text fontSize="xs" color="green.600" mt={1}>
                  Currently enabled
                </Text>
              )}
            </Flex>
            
            <Flex align="center" gap={2}>
              {isUpdating && (
                <Spinner size="sm" color="blue.500" />
              )}
              <Switch.Root
                checked={isEnabled}
                onCheckedChange={handleTogglePassphrase}
                disabled={isUpdating}
                colorPalette="blue"
                size="lg"
              >
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </Flex>
          </Flex>

          {(isUpdating || statusMessage) && (
            <Box p={3} 
                 bg={statusMessage?.startsWith('Error') ? "red.50" : 
                     statusMessage?.includes('unplug') ? "orange.50" : "blue.50"} 
                 borderRadius="md" 
                 borderLeft="4px" 
                 borderLeftColor={statusMessage?.startsWith('Error') ? "red.400" : 
                                  statusMessage?.includes('unplug') ? "orange.400" : "blue.400"}>
              <Flex align="center" gap={2}>
                {isUpdating && !statusMessage?.includes('unplug') && <Spinner size="sm" color="blue.500" />}
                <Text fontWeight="bold" 
                      fontSize={statusMessage?.includes('unplug') ? "md" : "sm"} 
                      color={statusMessage?.startsWith('Error') ? "red.600" : 
                             statusMessage?.includes('unplug') ? "orange.600" : "blue.600"}>
                  {statusMessage || 'Updating passphrase protection settings...'}
                </Text>
              </Flex>
            </Box>
          )}
      </Flex>
    </Box>
  );
};