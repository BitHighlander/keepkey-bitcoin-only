import { Box, VStack, Text, Button } from "@chakra-ui/react";
import { RecoveryFlow } from "../../WalletCreationWizard/RecoveryFlow";
import { RecoverySettings } from "../../WalletCreationWizard/RecoverySettings";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

interface Step4BackupOrRecoverProps {
  deviceId: string;
  wizardData: any;
  updateWizardData: (data: any) => void;
  onNext: () => void;
  onBack: () => void;
  flowType: 'create' | 'recover' | null;
}

export function Step4BackupOrRecover({ 
  deviceId, 
  wizardData, 
  updateWizardData, 
  onNext,
  onBack,
  flowType 
}: Step4BackupOrRecoverProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecoverySettings, setShowRecoverySettings] = useState(true);

  console.log("Step4BackupOrRecover rendered with flowType:", flowType);

  // Create flow - show backup phrase
  if (flowType === 'create') {
    const handleBackupComplete = async () => {
      setIsLoading(true);
      try {
        await invoke('complete_wallet_creation', { deviceId });
        // Update wizard data to indicate we should skip device label
        updateWizardData({ skipDeviceLabel: true });
        onNext();
      } catch (err) {
        console.error("Failed to complete wallet creation:", err);
        setError(`Failed to complete wallet creation: ${err}`);
      } finally {
        setIsLoading(false);
      }
    };

    return (
      <VStack gap={6} w="100%" maxW="600px" mx="auto" align="center" justify="center">
        <VStack gap={4} w="100%">
          <Text 
            fontSize="4xl" 
            fontWeight="bold" 
            color="white"
            textAlign="center"
          >
            Look at Your Device
          </Text>
          
          <Box 
            p={8} 
            bg="gray.800" 
            borderRadius="xl" 
            borderWidth="3px"
            borderColor="green.500"
            w="100%"
          >
            <VStack gap={4}>
              <Text fontSize="2xl" color="green.400" fontWeight="bold" textAlign="center">
                Your recovery phrase is displayed on your KeepKey screen
              </Text>
              <Text fontSize="lg" color="gray.300" textAlign="center">
                Write down each word exactly as shown on the device
              </Text>
            </VStack>
          </Box>

          <Box 
            p={4} 
            bg="red.900" 
            borderRadius="lg" 
            borderWidth="2px"
            borderColor="red.500"
            w="100%"
          >
            <Text color="red.300" fontWeight="bold" fontSize="lg" textAlign="center">
              ⚠️ YOU WILL ONLY SEE THIS ONCE
            </Text>
            <Text fontSize="md" color="gray.300" textAlign="center" mt={2}>
              This is by design - the phrase cannot be retrieved later
            </Text>
          </Box>

          <VStack gap={2} w="100%">
            <Text fontSize="md" color="gray.400" textAlign="center">
              Take your time to write down all words carefully
            </Text>
            <Text fontSize="sm" color="gray.500" textAlign="center">
              The device will wait for your confirmation
            </Text>
          </VStack>
        </VStack>

        {error && (
          <Text color="red.400" fontSize="sm">
            {error}
          </Text>
        )}

        <Button
          colorScheme="green"
          size="lg"
          w="100%"
          onClick={handleBackupComplete}
          loading={isLoading}
          loadingText="Completing setup..."
          _hover={{ transform: "scale(1.02)" }}
        >
          I Have Written Down My Recovery Phrase
        </Button>
      </VStack>
    );
  }

  // Recover flow - show recovery options then recovery flow
  if (flowType === 'recover') {
    if (showRecoverySettings && !wizardData.recoverySettings) {
      const handleRecoverySettingsComplete = (settings: any) => {
        updateWizardData({ recoverySettings: settings });
        setShowRecoverySettings(false);
      };

      return (
        <RecoverySettings
          onComplete={handleRecoverySettingsComplete}
          onBack={onBack}
          isLoading={false}
          error={null}
        />
      );
    }

    const handleRecoveryComplete = async () => {
      setIsLoading(true);
      try {
        // Mark recovery complete in wizard state and skip PIN/label steps
        updateWizardData({ recoveryCompleted: true, skipDeviceLabel: true, skipPinSetup: true });
        onNext();
      } catch (err) {
        console.error("Failed to complete recovery:", err);
        setError(`Failed to complete recovery: ${err}`);
      } finally {
        setIsLoading(false);
      }
    };

    const handleRecoveryError = (error: string) => {
      setError(error);
    };

    return (
      <RecoveryFlow
        deviceId={deviceId}
        wordCount={wizardData.recoverySettings?.wordCount || 12}
        passphraseProtection={wizardData.recoverySettings?.usePassphrase || false}
        deviceLabel={wizardData.deviceLabel || 'KeepKey Recovery'}
        onComplete={handleRecoveryComplete}
        onError={handleRecoveryError}
        onBack={() => {
          setShowRecoverySettings(true);
          updateWizardData({ recoverySettings: null });
        }}
      />
    );
  }

  return null;
}