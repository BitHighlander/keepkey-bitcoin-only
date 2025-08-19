import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Text,
  Button,
  HStack,
  VStack,
  Spinner,
  IconButton,
  SimpleGrid,
  Heading,
  Icon,
} from '@chakra-ui/react';
import { LuX, LuDelete, LuEye, LuEyeOff } from 'react-icons/lu';
import { 
  FaCircle, 
  FaExclamationTriangle, 
  FaTimes, 
  FaCheckCircle, 
  FaSync, 
  FaBackspace, 
  FaUsb 
} from 'react-icons/fa';
import { invoke } from '@tauri-apps/api/core';
import { useTypedTranslation } from '../hooks/useTypedTranslation';

interface PinPassphraseDialogProps {
  isOpen: boolean;
  deviceId: string;
  requestId?: string;
  operationType?: string;
  onComplete?: () => void;
  onCancel?: () => void;
  onClose: () => void;
}

// The KeepKey device shows this scrambled layout on its screen:
// 7 8 9
// 4 5 6
// 1 2 3
// We need to send these exact numbers when the user clicks each position
const PIN_MATRIX_LAYOUT = [7, 8, 9, 4, 5, 6, 1, 2, 3] as const;

type DialogStep = 'verifying' | 'trigger' | 'pin-entry' | 'pin-submitting' | 'passphrase-entry' | 'passphrase-submitting' | 'success' | 'reconnect';

export const PinPassphraseDialog = ({ 
  isOpen, 
  deviceId, 
  requestId,
  operationType = 'operation',
  onComplete, 
  onCancel,
  onClose 
}: PinPassphraseDialogProps) => {
  const { t } = useTypedTranslation('dialogs');
  
  // PIN state
  const [pinPositions, setPinPositions] = useState<number[]>([]);
  const [pinError, setPinError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [deviceReadyStatus, setDeviceReadyStatus] = useState<string>('Checking device...');
  
  // Passphrase state
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [hasSubmittedPassphraseForSession, setHasSubmittedPassphraseForSession] = useState(false);
  const [awaitingDeviceConfirmation, setAwaitingDeviceConfirmation] = useState(false);
  
  // General state
  const [step, setStep] = useState<DialogStep>('verifying');
  const [isLoading, setIsLoading] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPinPositions([]);
      setPinError(null);
      setPassphrase('');
      setPassphraseError(null);
      setHasSubmittedPassphraseForSession(false);
      setAwaitingDeviceConfirmation(false);
      setStep('verifying');
      setRetryCount(0);
      setDeviceReadyStatus('Checking device...');
      verifyDeviceReadiness();
    }
  }, [isOpen]);
  
  // Listen for passphrase events to auto-transition
  useEffect(() => {
    if (!isOpen) return;
    
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      
      const unlisten = await listen('device:awaiting_passphrase', (event: any) => {
        console.log('🔐 [PinPassphraseDialog] Received passphrase request event:', event);
        if (event.payload?.device_id === deviceId && step === 'pin-submitting') {
          console.log('🔐 [PinPassphraseDialog] Auto-transitioning to passphrase step');
          setStep('passphrase-entry');
        }
      });
      
      return unlisten;
    };
    
    let unlistenFn: (() => void) | undefined;
    setupListener().then(fn => { unlistenFn = fn; });
    
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [isOpen, deviceId, step]);

  const verifyDeviceReadiness = async () => {
    try {
      setIsLoading(true);
      setPinError(null);
      setDeviceReadyStatus('Checking device status...');
      console.log('🔍 Checking device status for:', deviceId);
      
      // First check if device needs PIN or just passphrase
      try {
        const status = await invoke('get_device_status', { deviceId });
        console.log('📱 Device status:', status);
        
        // Check if PIN is cached (device is already unlocked for PIN)
        // The status object has features nested inside
        if (status && status.features && status.features.pin_cached === true) {
          console.log('🔐 PIN is cached, device only needs passphrase');
          // Skip directly to passphrase step
          setStep('passphrase-entry');
          setIsLoading(false);
          return;
        }
      } catch (err) {
        console.log('⚠️ Could not check device status, continuing with PIN flow:', err);
      }
      
      // Check if device is already in PIN flow
      const isInPinFlow = await invoke('check_device_in_pin_flow', { deviceId });
      if (isInPinFlow) {
        console.log('🔐 Device already in PIN flow, ready for PIN entry');
        setDeviceReadyStatus('Device ready - PIN matrix should be visible on device');
        setStep('pin-entry');
        setIsLoading(false);
        return;
      }
      
      // Device needs PIN but hasn't been triggered yet - trigger it now
      console.log('🔐 Device needs PIN, triggering PIN request...');
      setDeviceReadyStatus('Requesting PIN from device...');
      
      try {
        const result = await invoke('trigger_pin_request', { deviceId });
        if (result === true) {
          console.log('✅ PIN trigger successful, device should be showing PIN matrix');
          setStep('pin-entry');
          setDeviceReadyStatus('PIN matrix ready');
        } else {
          console.log('⚠️ PIN trigger returned false, showing trigger button');
          setStep('trigger');
          setDeviceReadyStatus('Please trigger PIN manually');
        }
      } catch (err) {
        console.log('⚠️ PIN trigger failed, showing trigger button:', err);
        setStep('trigger');
        setDeviceReadyStatus('Please trigger PIN manually');
      }
      
    } catch (err: any) {
      console.error('❌ Device readiness verification failed:', err);
      setPinError(`Device not ready: ${err}`);
      setStep('trigger');
      setDeviceReadyStatus('Device not ready');
    } finally {
      setIsLoading(false);
    }
  };

  const triggerPinRequest = async () => {
    try {
      setIsLoading(true);
      setPinError(null);
      setDeviceReadyStatus('Checking device lock status...');
      console.log('🔐 Triggering PIN request for device:', deviceId);
      
      // Check if device is already in PIN flow to avoid duplicate requests
      const isInPinFlow = await invoke('check_device_in_pin_flow', { deviceId });
      if (isInPinFlow) {
        console.log('🔐 Device already in PIN flow, skipping trigger');
        setDeviceReadyStatus('Device ready - PIN matrix should be visible on device');
        setStep('pin-entry');
        return;
      }
      
      const result = await invoke('trigger_pin_request', { deviceId });
      
      if (result === true) {
        // Small delay to check if device is actually showing PIN
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const isInPinFlow = await invoke('check_device_in_pin_flow', { deviceId }).catch(() => false);
        
        if (isInPinFlow) {
          console.log('✅ PIN trigger successful, device should be showing PIN matrix');
          setStep('pin-entry');
          setDeviceReadyStatus('PIN matrix ready');
          setPinError(null);
        } else {
          console.log('✅ Device is already unlocked, checking if passphrase is needed');
          // Device is unlocked, check if we need passphrase
          setStep('passphrase-entry');
          setDeviceReadyStatus('Device unlocked, checking passphrase requirements');
        }
      } else {
        throw new Error('PIN trigger returned unexpected result');
      }
      
    } catch (err: any) {
      console.error('❌ PIN trigger failed:', err);
      
      const errorStr = String(err).toLowerCase();
      
      // Check if device is already showing PIN matrix (expected "failure")
      if (errorStr.includes('unknown message') || errorStr.includes('failure: unknown message')) {
        console.log('🔐 Device is already in PIN mode (expected behavior), proceeding to PIN entry');
        setStep('pin-entry');
        setDeviceReadyStatus('PIN matrix ready');
        setPinError(null);
        return;
      }
      
      // Handle various device communication issues
      if (errorStr.includes('device not found') || errorStr.includes('not connected')) {
        setPinError('Device disconnected. Please reconnect your KeepKey and try again.');
        setStep('trigger');
      } else if (errorStr.includes('device already in use') || errorStr.includes('claimed')) {
        setPinError('Device is being used by another application. Please close other wallet software and try again.');
        setStep('trigger');
      } else if (errorStr.includes('timeout')) {
        setPinError('Device communication timeout. Please check your connection and try again.');
        setStep('trigger');
      } else {
        const userFriendlyError = errorStr.includes('failed to trigger pin request') 
          ? 'Unable to request PIN from device. Please check your device screen and try again.'
          : `Communication error: ${err}`;
        
        setPinError(userFriendlyError);
        setStep('trigger');
      }
      
      setDeviceReadyStatus('PIN request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePinButtonClick = useCallback((position: number) => {
    if (pinPositions.length >= 9) return;
    console.log('Button clicked: position', position);
    setPinPositions(prev => [...prev, position]);
  }, [pinPositions.length]);

  const handlePinBackspace = useCallback(() => {
    setPinPositions(prev => prev.slice(0, -1));
  }, []);

  const handlePinClear = () => {
    setPinPositions([]);
  };

  const handleSubmitPin = async () => {
    if (pinPositions.length === 0) {
      setPinError('Please enter your PIN');
      return;
    }

    try {
      setStep('pin-submitting');
      setPinError(null);
      console.log('🔐 Submitting PIN with positions:', pinPositions);
      
      const result = await invoke('send_pin_matrix_ack', { 
        deviceId, 
        positions: pinPositions 
      });
      
      if (result === true) {
        console.log('✅ PIN submitted successfully');
        
        // Check if device has passphrase protection enabled
        try {
          const status = await invoke('get_device_status', { deviceId });
          console.log('📱 Device status after PIN:', status);
          
          // If passphrase protection is enabled, transition to passphrase step
          // The backend will already be expecting a PassphraseAck
          if (status && status.features && status.features.passphrase_protection) {
            console.log('🔐 Device has passphrase protection enabled, moving to passphrase step');
            setStep('passphrase-entry');
          } else {
            // No passphrase needed, we're done
            console.log('✅ PIN successful, no passphrase protection enabled');
            setStep('success');
            setTimeout(() => {
              if (onComplete) onComplete();
              onClose();
            }, 500);
          }
        } catch (err) {
          console.log('⚠️ Could not check passphrase status, assuming it is needed:', err);
          // If we can't check, assume passphrase is needed (safer)
          setStep('passphrase-entry');
        }
      } else {
        throw new Error('PIN verification failed');
      }
      
    } catch (err: any) {
      const errorStr = String(err);
      
      // Check if this is actually a success case (PassphraseRequest)
      if (errorStr.includes('PassphraseRequest')) {
        console.log('✅ PIN accepted, device is requesting passphrase');
        setStep('passphrase-entry');
        return;
      }
      
      console.error('❌ PIN submission failed:', err);
      
      // Handle PIN validation errors
      if (errorStr.toLowerCase().includes('incorrect') || errorStr.toLowerCase().includes('invalid') || errorStr.toLowerCase().includes('wrong')) {
        setPinError('Incorrect PIN. Please check your device screen and try again.');
        setRetryCount(prev => prev + 1);
        
        if (retryCount >= 2) {
          setPinError('Incorrect PIN. Warning: Too many failed attempts may temporarily lock your device!');
        }
      } else if (errorStr.toLowerCase().includes('device not found')) {
        setPinError('Device disconnected during PIN entry. Please reconnect and try again.');
      } else if (errorStr.toLowerCase().includes('locked') || errorStr.toLowerCase().includes('too many')) {
        setPinError('Device is temporarily locked due to too many failed PIN attempts. Please wait and try again later.');
        setStep('trigger');
        return;
      } else {
        setPinError(`PIN verification failed: ${err}`);
      }
      
      // Reset to PIN entry step and clear entered PIN
      setPinPositions([]);
      setStep('pin-entry');
    }
  };

  const handleSubmitPassphrase = async () => {
    // Prevent duplicate submissions for the same session
    if (hasSubmittedPassphraseForSession) {
      console.log('🔐 [PinPassphraseDialog] Preventing duplicate passphrase submission');
      setPassphraseError('Passphrase already submitted. Please confirm on your device.');
      return;
    }

    // Basic validation
    if (!passphrase) {
      setPassphraseError('Please enter a passphrase');
      return;
    }

    if (!deviceId) {
      setPassphraseError('No device ID available');
      return;
    }

    setStep('passphrase-submitting');
    setPassphraseError(null);

    try {
      console.log('🔐 [PinPassphraseDialog] Sending passphrase for device:', deviceId);
      // Use the correct backend command for sending passphrase
      // If we have a requestId from the backend event, use the new command
      if (requestId) {
        await invoke('passphrase_submit', {
          deviceId,
          requestId,
          passphrase: passphrase || '', // Empty string for no passphrase
        });
      } else {
        // Fallback to the old command
        await invoke('send_passphrase_ack', {
          deviceId,
          passphrase: passphrase || '', // Empty string for no passphrase
        });
      }

      // Mark as submitted for this session
      setHasSubmittedPassphraseForSession(true);
      setAwaitingDeviceConfirmation(true);
      
      // Clear sensitive data
      setPassphrase('');
      
      // Show confirmation message
      setPassphraseError(null);
      console.log('🔐 [PinPassphraseDialog] Passphrase sent successfully, awaiting device confirmation');
      
      // Complete the process after a brief confirmation period
      setTimeout(() => {
        setStep('success');
        setTimeout(() => {
          if (onComplete) onComplete();
          onClose();
        }, 500);
      }, 1000);
      
    } catch (err) {
      console.error('🔐 [PinPassphraseDialog] Failed to send passphrase:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to send passphrase';
      
      // Handle different types of passphrase errors
      if (errorMessage.includes('Unexpected message')) {
        setPassphraseError('Device not ready for passphrase. Please try the operation again.');
        setHasSubmittedPassphraseForSession(true);
        
        setTimeout(() => {
          onClose();
        }, 2000);
      } else if (errorMessage.includes('timed out')) {
        setPassphraseError('Operation timed out. Please confirm on your device or try again.');
        setHasSubmittedPassphraseForSession(false);
        setAwaitingDeviceConfirmation(false);
        setStep('passphrase-entry');
      } else {
        setPassphraseError(errorMessage);
        setHasSubmittedPassphraseForSession(false);
        setAwaitingDeviceConfirmation(false);
        setStep('passphrase-entry');
      }
    }
  };

  const handleSkipPassphrase = async () => {
    console.log('🔐 [PinPassphraseDialog] Skipping passphrase (using empty passphrase)');
    
    // Directly send empty passphrase
    setStep('passphrase-submitting');
    setPassphraseError(null);
    
    try {
      // Use the correct backend command for sending empty passphrase
      if (requestId) {
        await invoke('passphrase_submit', {
          deviceId,
          requestId,
          passphrase: '', // Empty passphrase
        });
      } else {
        // Fallback to the old command
        await invoke('send_passphrase_ack', {
          deviceId,
          passphrase: '', // Empty passphrase
        });
      }
      
      console.log('🔐 [PinPassphraseDialog] Empty passphrase sent successfully');
      setStep('success');
      setTimeout(() => {
        if (onComplete) onComplete();
        onClose();
      }, 500);
    } catch (err) {
      console.error('🔐 [PinPassphraseDialog] Failed to send empty passphrase:', err);
      setPassphraseError('Failed to skip passphrase');
      setStep('passphrase-entry');
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    }
    onClose();
  };

  const handleRetry = () => {
    setPinError(null);
    setRetryCount(prev => prev + 1);
    
    if (retryCount >= 2) {
      setStep('verifying');
      verifyDeviceReadiness();
    } else {
      setStep('trigger');
      triggerPinRequest();
    }
  };

  const getOperationDescription = () => {
    switch (operationType) {
      case 'settings':
        return 'Enter your PIN and passphrase to confirm settings change';
      case 'tx':
        return 'Enter your PIN and passphrase to sign transaction';
      case 'export':
        return 'Enter your PIN and passphrase to export data';
      default:
        return 'Enter your PIN and passphrase to continue';
    }
  };

  // Generate PIN dots for display
  const pinDots = Array.from({ length: Math.max(4, pinPositions.length) }, (_, i) => (
    <Box
      key={i}
      w="10px"
      h="10px"
      borderRadius="full"
      bg={i < pinPositions.length ? "green.400" : "gray.600"}
      opacity={i < pinPositions.length ? 1 : 0.5}
      transition="all 0.2s"
    />
  ));

  if (!isOpen) return null;

  return (
    <Box
      position="fixed"
      top={0}
      left={0}
      right={0}
      bottom={0}
      bg="blackAlpha.800"
      zIndex={99999}
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      <Box
        bg="gray.800"
        color="white"
        borderRadius="xl"
        boxShadow="2xl"
        borderWidth="1px"
        borderColor="gray.700"
        overflow="hidden"
        maxW="450px"
        w="90%"
      >
        {/* Header */}
        <Box bg="gray.850" p={4} position="relative">
          <Heading fontSize="xl" fontWeight="bold" color="white" textAlign="center">
            {step.startsWith('pin') || step === 'verifying' || step === 'trigger' 
              ? t('pin.unlock.title')
              : step.startsWith('passphrase') 
              ? 'Enter Passphrase'
              : 'Authentication Required'}
          </Heading>
          <Button
            position="absolute"
            right={2}
            top="50%"
            transform="translateY(-50%)"
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            disabled={step === 'pin-submitting' || step === 'passphrase-submitting'}
            color="gray.400"
            _hover={{ color: "white", bg: "gray.700" }}
            borderRadius="md"
          >
            <Icon as={FaTimes} />
          </Button>
        </Box>

        <Box p={5}>
          <VStack spacing={6} py={4}>
            <Text fontSize="md" color="gray.300" textAlign="center">
              {getOperationDescription()}
            </Text>

            {/* PIN Steps */}
            {step === 'verifying' && (
              <VStack gap={3} py={4}>
                <Spinner size="lg" color="blue.400" />
                <Text fontSize="md" fontWeight="semibold">
                  Preparing Device
                </Text>
                <Text fontSize="sm" color="gray.400">
                  {deviceReadyStatus}
                </Text>
              </VStack>
            )}

            {step === 'trigger' && (
              <VStack gap={3} py={4}>
                <Text color="gray.300" fontSize="sm">
                  Device ready for PIN entry
                </Text>
                {isLoading ? (
                  <Spinner size="md" color="blue.400" />
                ) : (
                  <Button onClick={triggerPinRequest} colorScheme="blue" size="md">
                    Request PIN Matrix
                  </Button>
                )}
              </VStack>
            )}

            {step === 'pin-entry' && (
              <VStack gap={4} w="full">
                <VStack gap={1}>
                  <Text color="gray.300" fontSize="sm" textAlign="center">
                    Look at your device screen for the numbers layout
                  </Text>
                  <Text color="gray.400" fontSize="xs" textAlign="center">
                    Click the positions that match the numbers shown on your device
                  </Text>
                </VStack>

                {/* PIN Display */}
                <Box
                  p={3}
                  bg="gray.750"
                  borderRadius="lg"
                  borderWidth="1px"
                  borderColor="gray.600"
                >
                  <HStack spacing={2} justify="center">
                    {pinDots}
                  </HStack>
                </Box>

                {/* PIN Matrix */}
                <Box
                  p={4}
                  borderRadius="lg"
                  borderWidth="1px"
                  borderColor="gray.600"
                  bg="gray.750"
                >
                  <SimpleGrid
                    columns={3}
                    gap={2}
                    w="180px"
                    mx="auto"
                  >
                    {PIN_MATRIX_LAYOUT.map((position, index) => (
                      <Button
                        key={index}
                        onClick={() => handlePinButtonClick(position)}
                        isDisabled={pinPositions.length >= 9}
                        size="lg"
                        h="50px"
                        w="50px"
                        fontSize="xl"
                        bg="gray.700"
                        borderWidth="1px"
                        borderColor="gray.600"
                        color="white"
                        _hover={{ bg: 'gray.600', borderColor: 'blue.400' }}
                        _active={{ bg: 'gray.650' }}
                      >
                        <Icon as={FaCircle} boxSize={3} />
                      </Button>
                    ))}
                  </SimpleGrid>

                  <HStack mt={3} spacing={2} justify="center">
                    <Button
                      leftIcon={<LuDelete />}
                      onClick={handlePinBackspace}
                      isDisabled={pinPositions.length === 0}
                      size="sm"
                      variant="outline"
                    >
                      Back
                    </Button>
                    <Button
                      onClick={handlePinClear}
                      isDisabled={pinPositions.length === 0}
                      size="sm"
                      variant="outline"
                    >
                      Clear
                    </Button>
                  </HStack>
                </Box>
              </VStack>
            )}

            {step === 'pin-submitting' && (
              <VStack gap={3} py={4}>
                <Spinner size="lg" color="blue.400" />
                <Text fontSize="md" fontWeight="semibold">
                  Verifying PIN
                </Text>
                <Text fontSize="sm" color="gray.400">
                  Please wait...
                </Text>
              </VStack>
            )}

            {/* Passphrase Steps */}
            {step === 'passphrase-entry' && (
              <VStack gap={4} w="full">
                <VStack gap={1}>
                  <Text color="gray.300" fontSize="sm" textAlign="center">
                    {awaitingDeviceConfirmation 
                      ? 'Confirm on Device' 
                      : 'Enter Passphrase (Optional)'}
                  </Text>
                </VStack>

                {/* Instruction */}
                <Box
                  p={3}
                  borderRadius="md"
                  bg="blue.900"
                  borderWidth="1px"
                  borderColor="blue.700"
                  w="full"
                >
                  <Text color="blue.200" fontSize="sm" textAlign="center">
                    {awaitingDeviceConfirmation 
                      ? 'Please confirm the passphrase on your device'
                      : 'After submitting, you will need to confirm on your device'}
                  </Text>
                </Box>

                {/* Passphrase Input */}
                <Box position="relative" w="full">
                  <input
                    type={showPassphrase ? 'text' : 'password'}
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Enter passphrase (leave empty if no passphrase)"
                    autoComplete="off"
                    disabled={awaitingDeviceConfirmation}
                    style={{
                      width: '100%',
                      padding: '12px 40px 12px 12px',
                      border: '2px solid #4A5568',
                      borderRadius: '8px',
                      fontSize: '16px',
                      backgroundColor: '#2D3748',
                      color: 'white',
                      outline: 'none',
                    }}
                  />
                  <IconButton
                    position="absolute"
                    right="8px"
                    top="50%"
                    transform="translateY(-50%)"
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowPassphrase(!showPassphrase)}
                    isDisabled={awaitingDeviceConfirmation}
                  >
                    {showPassphrase ? <LuEyeOff /> : <LuEye />}
                  </IconButton>
                </Box>

                {/* Warning */}
                <Box
                  p={3}
                  borderRadius="md"
                  bg="orange.900"
                  borderWidth="1px"
                  borderColor="orange.700"
                  w="full"
                >
                  <VStack gap={1} align="start">
                    <Text fontWeight="bold" color="orange.300" fontSize="sm">
                      Use with Caution
                    </Text>
                    <Text color="orange.400" fontSize="xs">
                      Wrong passphrases create different wallets. You will lose access to your funds if you forget it.
                    </Text>
                  </VStack>
                </Box>
              </VStack>
            )}

            {step === 'passphrase-submitting' && (
              <VStack gap={3} py={4}>
                <Spinner size="lg" color="blue.400" />
                <Text fontSize="md" fontWeight="semibold">
                  Submitting Passphrase
                </Text>
                <Text fontSize="sm" color="gray.400">
                  Please confirm on your device...
                </Text>
              </VStack>
            )}

            {step === 'success' && (
              <VStack gap={3} py={4}>
                <Icon as={FaCheckCircle} color="green.400" boxSize={10} />
                <Text fontSize="md" fontWeight="semibold" color="green.400">
                  Authentication Successful
                </Text>
              </VStack>
            )}

            {/* Error Messages */}
            {(pinError || passphraseError) && step !== 'success' && (
              <Box
                p={3}
                borderRadius="md"
                bg="red.900"
                borderWidth="1px"
                borderColor="red.700"
                w="full"
              >
                <HStack gap={2} align="start">
                  <Icon as={FaExclamationTriangle} color="red.400" mt={0.5} boxSize={4} />
                  <VStack align="start" gap={1} flex={1}>
                    <Text color="red.300" fontSize="sm">
                      {pinError || passphraseError}
                    </Text>
                    {pinError && (
                      <Button 
                        size="xs" 
                        colorScheme="red" 
                        variant="outline" 
                        onClick={handleRetry}
                      >
                        <Icon as={FaSync} mr={1} />
                        {retryCount >= 2 ? 'Full Retry' : 'Try Again'}
                      </Button>
                    )}
                  </VStack>
                </HStack>
              </Box>
            )}
          </VStack>
        </Box>

        {/* Footer */}
        <Box p={4} borderTopWidth="1px" borderColor="gray.700" bg="gray.850">
          <HStack spacing={3} justify="flex-end">
            <Button 
              variant="outline" 
              onClick={handleCancel}
              isDisabled={step === 'pin-submitting' || step === 'passphrase-submitting'}
              borderColor="gray.600"
              color="gray.300"
              _hover={{ bg: "gray.700" }}
            >
              Cancel
            </Button>
            
            {step === 'pin-entry' && (
              <Button
                colorScheme="blue"
                onClick={handleSubmitPin}
                isDisabled={pinPositions.length === 0}
              >
                Submit PIN
              </Button>
            )}
            
            {step === 'passphrase-entry' && !awaitingDeviceConfirmation && (
              <>
                <Button
                  variant="outline"
                  onClick={handleSkipPassphrase}
                  isDisabled={hasSubmittedPassphraseForSession}
                >
                  Skip Passphrase
                </Button>
                <Button
                  colorScheme="blue"
                  onClick={handleSubmitPassphrase}
                  isDisabled={hasSubmittedPassphraseForSession}
                >
                  Submit Passphrase
                </Button>
              </>
            )}
          </HStack>
        </Box>
      </Box>
    </Box>
  );
};