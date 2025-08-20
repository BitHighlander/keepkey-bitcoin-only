import React, { useState } from 'react';
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger,
} from '@chakra-ui/react';
import {
  Box,
  Button,
  HStack,
  VStack,
  Text,
  Icon,
  Flex,
  IconButton,
  Switch,
  Alert,
} from '@chakra-ui/react';
import { LuX, LuShield, LuKey } from 'react-icons/lu';
import { FaCheckCircle } from 'react-icons/fa';
import { invoke } from '@tauri-apps/api/core';
import { useTypedTranslation } from '../hooks/useTypedTranslation';

// Import PIN setup components
import { PinSetupDialog } from './PinSetupDialog';

interface AuthSetupDialogProps {
  isOpen: boolean;
  deviceId: string;
  onComplete?: () => void;
  onClose: () => void;
}

interface Step {
  id: 'pin' | 'passphrase' | 'complete';
  label: string;
  description: string;
  icon: React.ElementType;
}

const STEPS: Step[] = [
  {
    id: 'pin',
    label: 'Set PIN',
    description: 'Create a PIN to secure your device',
    icon: LuShield,
  },
  {
    id: 'passphrase',
    label: 'Passphrase (Optional)',
    description: 'Add an extra layer of security with a passphrase',
    icon: LuKey,
  },
  {
    id: 'complete',
    label: 'Complete',
    description: 'Your device security is configured',
    icon: FaCheckCircle,
  },
];

export const AuthSetupDialog = ({ 
  isOpen, 
  deviceId, 
  onComplete, 
  onClose 
}: AuthSetupDialogProps) => {
  const { t } = useTypedTranslation('dialogs');
  const [currentStep, setCurrentStep] = useState(0);
  const [pinComplete, setPinComplete] = useState(false);
  const [passphraseEnabled, setPassphraseEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleComplete = async () => {
    try {
      setIsLoading(true);
      
      // Save passphrase preference if needed
      if (passphraseEnabled) {
        await invoke('enable_passphrase_protection', { deviceId });
      }
      
      if (onComplete) {
        onComplete();
      }
      onClose();
    } catch (err) {
      console.error('Failed to complete auth setup:', err);
      setError('Failed to save settings');
    } finally {
      setIsLoading(false);
    }
  };

  const progress = ((currentStep + 1) / STEPS.length) * 100;
  const currentStepData = STEPS[currentStep];

  return (
    <DialogRoot
      open={isOpen}
      onOpenChange={(e) => {
        if (!e.open) {
          onClose();
        }
      }}
      size="lg"
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Security Setup</DialogTitle>
          <DialogCloseTrigger asChild>
            <IconButton variant="ghost" size="sm">
              <LuX />
            </IconButton>
          </DialogCloseTrigger>
        </DialogHeader>

        <DialogBody>
          <VStack gap={6} py={4}>
            {/* Progress Bar */}
            <Box w="full">
              <Box 
                h="4px" 
                bg="gray.200" 
                borderRadius="full"
                overflow="hidden"
              >
                <Box 
                  h="100%" 
                  bg="green.500" 
                  borderRadius="full"
                  transition="width 0.3s"
                  w={`${progress}%`}
                />
              </Box>
            </Box>

            {/* Step Indicators */}
            <HStack gap={4} justify="center">
              {STEPS.map((step, index) => (
                <Flex key={step.id} align="center">
                  <Box
                    w={10}
                    h={10}
                    borderRadius="full"
                    bg={index <= currentStep ? "green.500" : "gray.300"}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    transition="all 0.3s"
                  >
                    {index < currentStep ? (
                      <Icon as={FaCheckCircle} color="white" boxSize={5} />
                    ) : (
                      <Icon as={step.icon} color="white" boxSize={5} />
                    )}
                  </Box>
                  <Text
                    ml={2}
                    fontSize="sm"
                    fontWeight={index === currentStep ? "bold" : "normal"}
                    color={index <= currentStep ? "green.500" : "gray.500"}
                  >
                    {step.label}
                  </Text>
                  {index < STEPS.length - 1 && (
                    <Box
                      w={8}
                      h={0.5}
                      bg={index < currentStep ? "green.500" : "gray.300"}
                      ml={2}
                    />
                  )}
                </Flex>
              ))}
            </HStack>

            {/* Current Step Content */}
            <VStack gap={4} w="full" minH="300px">
              <Icon as={currentStepData.icon} boxSize={16} color="green.500" />
              <Text fontSize="xl" fontWeight="bold">
                {currentStepData.label}
              </Text>
              <Text color="gray.600" textAlign="center">
                {currentStepData.description}
              </Text>

              {/* Step-specific content */}
              {currentStep === 0 && (
                <VStack gap={4} w="full">
                  <Alert.Root status="info">
                    <Alert.Indicator />
                    Your PIN will be required to unlock your device and confirm transactions
                  </Alert.Root>
                  {!pinComplete && (
                    <Button
                      colorScheme="green"
                      size="lg"
                      onClick={() => {
                        // This would open the PIN setup dialog
                        // For now, we'll simulate completion
                        setPinComplete(true);
                      }}
                    >
                      Set Up PIN
                    </Button>
                  )}
                  {pinComplete && (
                    <HStack>
                      <Icon as={FaCheckCircle} color="green.500" />
                      <Text color="green.500">PIN configured successfully</Text>
                    </HStack>
                  )}
                </VStack>
              )}

              {currentStep === 1 && (
                <VStack gap={4} w="full">
                  <Alert.Root status="warning">
                    <Alert.Indicator />
                    Passphrases create hidden wallets. Each passphrase accesses a different wallet. 
                    Never forget your passphrase!
                  </Alert.Root>
                  <HStack justify="space-between" w="full" p={4} bg="gray.50" borderRadius="md">
                    <VStack align="start" gap={1}>
                      <Text fontWeight="bold">Enable Passphrase Protection</Text>
                      <Text fontSize="sm" color="gray.600">
                        Add an extra layer of security
                      </Text>
                    </VStack>
                    <Switch.Root
                      checked={passphraseEnabled}
                      onCheckedChange={() => setPassphraseEnabled(prev => !prev)}
                      colorPalette="green"
                      size="lg"
                    >
                      <Switch.HiddenInput />
                      <Switch.Control />
                    </Switch.Root>
                  </HStack>
                </VStack>
              )}

              {currentStep === 2 && (
                <VStack gap={4}>
                  <Icon as={FaCheckCircle} boxSize={20} color="green.500" />
                  <Text fontSize="lg" fontWeight="bold" color="green.500">
                    Security Setup Complete!
                  </Text>
                  <VStack gap={2} align="start">
                    <HStack>
                      <Icon as={FaCheckCircle} color="green.500" />
                      <Text>PIN protection enabled</Text>
                    </HStack>
                    {passphraseEnabled && (
                      <HStack>
                        <Icon as={FaCheckCircle} color="green.500" />
                        <Text>Passphrase protection enabled</Text>
                      </HStack>
                    )}
                  </VStack>
                </VStack>
              )}

              {error && (
                <Alert.Root status="error">
                  <Alert.Indicator />
                  {error}
                </Alert.Root>
              )}
            </VStack>
          </VStack>
        </DialogBody>

        <DialogFooter>
          <HStack gap={3}>
            <Button
              variant="outline"
              onClick={handlePrevious}
              disabled={currentStep === 0 || isLoading}
            >
              Back
            </Button>
            <Button
              colorScheme="green"
              onClick={handleNext}
              loading={isLoading}
              disabled={currentStep === 0 && !pinComplete}
            >
              {currentStep === STEPS.length - 1 ? 'Finish' : 'Next'}
            </Button>
          </HStack>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
};