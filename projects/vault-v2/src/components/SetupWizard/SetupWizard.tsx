import {
  Box,
  Button,
  HStack,
  VStack,
  Text,
  Flex,
  Icon,
} from "@chakra-ui/react";
import { useState, useEffect, useRef } from "react";
import { FaCheckCircle } from "react-icons/fa";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDialog } from "../../contexts/DialogContext";
import { useTypedTranslation } from "../../hooks/useTypedTranslation";

// Import individual steps
import { Step0Welcome } from "./steps/Step0Welcome";
import { StepBootloaderUpdate } from "./steps/StepBootloaderUpdate";
import { StepFirmwareUpdate } from "./steps/StepFirmwareUpdate";
import { Step1CreateOrRecover } from "./steps/Step1CreateOrRecover";
import { Step2DeviceLabel } from "./steps/Step2DeviceLabel";
import { Step3Pin } from "./steps/Step3Pin";
import { Step4BackupOrRecover } from "./steps/Step4BackupOrRecover";
import { Step5Complete } from "./steps/Step5Complete";

interface SetupWizardProps {
  deviceId: string;
  onClose?: () => void;
  onComplete?: () => void;
  onFirmwareUpdateStart?: () => void;
  onFirmwareUpdateComplete?: () => void;
}

interface Step {
  id: string;
  label: string;
  description: string;
  component: React.ComponentType<any>;
}

// Define all steps (including hidden ones)
const CREATE_ALL_STEPS: Step[] = [
  {
    id: "welcome",
    label: "Welcome",
    description: "Welcome to KeepKey Bitcoin-Only",
    component: Step0Welcome,
  },
  {
    id: "bootloader",
    label: "Bootloader",
    description: "bootloaderUpdate.verifyUpdateBootloader",
    component: StepBootloaderUpdate,
  },
  {
    id: "firmware",
    label: "Firmware",
    description: "bootloaderUpdate.verifyUpdateFirmware",
    component: StepFirmwareUpdate,
  },
  {
    id: "create-or-recover",
    label: "Setup Type",
    description: "Choose your setup method",
    component: Step1CreateOrRecover,
  },
  {
    id: "pin",
    label: "Security",
    description: "Set up your PIN",
    component: Step3Pin,
  },
  {
    id: "backup",
    label: "Backup",
    description: "Backup your recovery phrase",
    component: Step4BackupOrRecover,
  },
  {
    id: "device-label",
    label: "Device Name",
    description: "Name your device",
    component: Step2DeviceLabel,
  },
  {
    id: "complete",
    label: "Complete",
    description: "Setup complete!",
    component: Step5Complete,
  },
];

const RECOVER_ALL_STEPS: Step[] = [
  {
    id: "welcome",
    label: "Welcome",
    description: "Welcome to KeepKey Bitcoin-Only",
    component: Step0Welcome,
  },
  {
    id: "bootloader",
    label: "Bootloader",
    description: "bootloaderUpdate.verifyUpdateBootloader",
    component: StepBootloaderUpdate,
  },
  {
    id: "firmware",
    label: "Firmware",
    description: "bootloaderUpdate.verifyUpdateFirmware",
    component: StepFirmwareUpdate,
  },
  {
    id: "create-or-recover",
    label: "Setup Type",
    description: "Choose your setup method",
    component: Step1CreateOrRecover,
  },
  {
    id: "recover",
    label: "Recovery",
    description: "Enter your recovery phrase",
    component: Step4BackupOrRecover,
  },
  {
    id: "pin",
    label: "Security",
    description: "Set up your PIN",
    component: Step3Pin,
  },
  {
    id: "device-label",
    label: "Device Name",
    description: "Name your device",
    component: Step2DeviceLabel,
  },
  {
    id: "complete",
    label: "Complete",
    description: "Recovery complete!",
    component: Step5Complete,
  },
];

// Define visible steps for progress bar
const CREATE_VISIBLE_STEPS = [
  { id: "bootloader", label: "bootloaderUpdate.checkBootloader", number: 1 },
  { id: "firmware", label: "bootloaderUpdate.checkFirmware", number: 2 },
  { id: "create-or-recover", label: "bootloaderUpdate.createWallet", number: 3 },
];

const RECOVER_VISIBLE_STEPS = [
  { id: "bootloader", label: "bootloaderUpdate.checkBootloader", number: 1 },
  { id: "firmware", label: "bootloaderUpdate.checkFirmware", number: 2 },
  { id: "create-or-recover", label: "bootloaderUpdate.recoverWallet", number: 3 },
];

export function SetupWizard({ deviceId: initialDeviceId, onClose, onComplete, onFirmwareUpdateStart, onFirmwareUpdateComplete }: SetupWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [flowType, setFlowType] = useState<'create' | 'recover' | null>(null);
  const [wizardData, setWizardData] = useState<{
    deviceLabel?: string;
    pinSession?: any;
    recoverySettings?: any;
  }>({});
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const justCompletedBootloaderUpdate = useRef(false);
  
  const highlightColor = "orange.500"; // Bitcoin orange
  const { hide } = useDialog();
  const { t } = useTypedTranslation('setup');
  
  // Listen for device connection events to update device ID after bootloader update
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    
    const setupListener = async () => {
      unsubscribe = await listen<{
        deviceId: string;
        features: any;
        status: any;
      }>('device:features-updated', (event) => {
        // If we just completed a bootloader update, update to the new device ID
        if (justCompletedBootloaderUpdate.current && event.payload.deviceId !== deviceId) {
          console.log('🔄 SetupWizard: Device ID changed after bootloader update:', {
            oldId: deviceId,
            newId: event.payload.deviceId
          });
          setDeviceId(event.payload.deviceId);
          justCompletedBootloaderUpdate.current = false;
        }
      });
    };
    
    setupListener();
    
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [deviceId]);

  // Determine which steps to use based on flow type
  const ALL_STEPS = flowType === 'recover' ? RECOVER_ALL_STEPS : CREATE_ALL_STEPS;
  const VISIBLE_STEPS = flowType === 'recover' ? RECOVER_VISIBLE_STEPS : CREATE_VISIBLE_STEPS;

  const handleNext = () => {
    console.log("=== SetupWizard handleNext called ===");
    console.log("Current step:", currentStep);
    console.log("Current step ID:", ALL_STEPS[currentStep].id);
    console.log("Total steps:", ALL_STEPS.length);
    console.log("Flow type:", flowType);
    
    if (currentStep < ALL_STEPS.length - 1) {
      const nextStep = currentStep + 1;
      const nextStepId = ALL_STEPS[nextStep].id;
      console.log("Moving to next step:", nextStep, "which is:", nextStepId);
      setCurrentStep(nextStep);
      console.log("setCurrentStep called with:", nextStep);
    } else {
      console.log("At final step, calling handleComplete");
      handleComplete();
    }
    console.log("=== handleNext completed ===");
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      // If going back from a step after flow type is chosen, reset flow type
      const createOrRecoverIndex = ALL_STEPS.findIndex(step => step.id === 'create-or-recover');
      if (currentStep > createOrRecoverIndex && ALL_STEPS[currentStep].id !== 'create-or-recover') {
        // Going back to or before the create-or-recover step
        if (currentStep - 1 <= createOrRecoverIndex) {
          setFlowType(null);
        }
      }
      setCurrentStep(currentStep - 1);
    }
  };

  const handleComplete = async () => {
    console.log("=== Starting setup completion ===");
    try {
      // Mark setup as completed
      console.log("Calling set_onboarding_completed...");
      await invoke("set_onboarding_completed");
      console.log("set_onboarding_completed completed successfully");

      // Call the completion callback if provided
      if (onComplete) {
        console.log("Calling onComplete callback");
        onComplete();
      }

      // Use multiple methods to ensure the dialog closes
      if (onClose) {
        console.log("Calling onClose callback");
        onClose();
      }

      // Use the dialog context directly to force close after a short delay
      setTimeout(() => {
        hide('setup-wizard');
        console.log('Forced setup wizard closure via DialogContext');
      }, 100);
    } catch (error) {
      console.error("Failed to mark setup as completed:", error);
    }
  };

  const handleFlowTypeSelection = (type: 'create' | 'recover') => {
    setFlowType(type);
    handleNext();
  };

  const updateWizardData = (data: Partial<typeof wizardData>) => {
    setWizardData(prev => ({ ...prev, ...data }));
  };
  
  const handleBootloaderUpdateComplete = () => {
    console.log('🔄 SetupWizard: Bootloader update completed, expecting device ID change');
    justCompletedBootloaderUpdate.current = true;
  };

  const StepComponent = effectiveAllSteps[currentStep].component;
  
  // Debug current step
  console.log("SetupWizard render - currentStep:", currentStep, "stepId:", effectiveAllSteps[currentStep].id, "component:", StepComponent.name);

  // Global Enter -> Next handler (except guarded steps)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      // If a recovery flow is actively locking the UI, do not advance
      if ((window as any).KEEPKEY_RECOVERY_IN_PROGRESS) return;
      // If any modal is active, do not advance wizard
      if ((window as any).KEEPKEY_MODAL_ACTIVE) return;
      // Do not auto-advance if focused on an editable input/textarea/select/button
      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        const tag = ae.tagName?.toLowerCase();
        if (['input', 'textarea', 'select', 'button'].includes(tag)) return;
        // contenteditable elements
        if ((ae as any).isContentEditable) return;
      }
      const stepId = effectiveAllSteps[currentStep].id;
      // Guard bootloader step from auto-enter next
      if (stepId === 'bootloader') return;
      // Require choice on flow selection
      if (stepId === 'create-or-recover' && !flowType) return;
      e.preventDefault();
      handleNext();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [currentStep, flowType]);
  
  // Calculate progress based on visible steps
  const currentStepId = effectiveAllSteps[currentStep].id;
  const visibleStepIndex = VISIBLE_STEPS.findIndex(step => step.id === currentStepId);
  
  // If we're past all visible steps, show 100% progress
  let actualProgress = 0;
  if (visibleStepIndex >= 0) {
    actualProgress = ((visibleStepIndex + 1) / VISIBLE_STEPS.length) * 100;
  } else {
    // Check if we're past all visible steps
    const lastVisibleStepId = VISIBLE_STEPS[VISIBLE_STEPS.length - 1].id;
    const lastVisibleStepIndex = effectiveAllSteps.findIndex(step => step.id === lastVisibleStepId);
    if (currentStep > lastVisibleStepIndex) {
      actualProgress = 100;
    }
  }

  // Props to pass to step components
  const stepProps = {
    deviceId,
    wizardData,
    updateWizardData,
    onNext: handleNext,
    onBack: handlePrevious,
    onFlowTypeSelect: handleFlowTypeSelection,
    flowType,
    onBootloaderUpdateComplete: handleBootloaderUpdateComplete,
    onFirmwareUpdateStart,
    onFirmwareUpdateComplete,
  };

  // If recovery completed, skip PIN setup step automatically
  const effectiveAllSteps = (() => {
    if (wizardData.recoveryCompleted) {
      const filtered = ALL_STEPS.filter(s => s.id !== 'pin');
      return filtered as typeof ALL_STEPS;
    }
    if (wizardData.skipPinSetup) {
      const filtered = ALL_STEPS.filter(s => s.id !== 'pin');
      return filtered as typeof ALL_STEPS;
    }
    return ALL_STEPS;
  })();

  return (
    <Box
      w={{ base: "100vw", md: "90vw", lg: "80vw" }}
      maxW="1200px"
      minH={{ base: "100vh", md: "auto" }}
      bg="gray.800"
      borderRadius={{ base: "none", md: "xl" }}
      boxShadow={{ base: "none", md: "xl" }}
      borderWidth={{ base: "0", md: "1px" }}
      borderColor="gray.700"
      overflow="hidden"
      mx="auto"
      my={{ base: 0, md: 4 }}
    >
      {/* Header */}
      <Box 
        p={6} 
        borderBottomWidth="1px" 
        borderColor="gray.700"
        bg="gray.850"
      >
        <VStack gap={4}>
          <Text fontSize="2xl" fontWeight="bold" color={highlightColor}>
            {t('bootloaderUpdate.keepKeyBitcoinSetup')}
          </Text>
          <Text fontSize="md" color="gray.400">
            {t(effectiveAllSteps[currentStep].description)}
          </Text>
        </VStack>
      </Box>

      {/* Progress */}
      <Box px={6} py={2}>
        <Box 
          h="4px" 
          bg="gray.700" 
          borderRadius="full"
          overflow="hidden"
        >
          <Box 
            h="100%" 
            bg={actualProgress > 0 ? "green.500" : highlightColor}
            borderRadius="full"
            transition="width 0.3s, background-color 0.3s"
            w={`${actualProgress}%`}
          />
        </Box>
      </Box>

      {/* Step indicators with improved responsive layout */}
      <Box px={4} py={3} overflowX="auto">
        <HStack 
          gap={{ base: 2, md: 3 }} 
          justify="center" 
          minW="fit-content"
          wrap="nowrap"
        >
          {VISIBLE_STEPS.map((step, index) => {
            const stepIndex = effectiveAllSteps.findIndex(s => s.id === step.id);
            const lastVisibleStepId = VISIBLE_STEPS[VISIBLE_STEPS.length - 1].id;
            const lastVisibleStepIndex = effectiveAllSteps.findIndex(s => s.id === lastVisibleStepId);
            const isPastAllVisible = currentStep > lastVisibleStepIndex;
            
            const isCompleted = isPastAllVisible || (stepIndex !== -1 && stepIndex < currentStep);
            const isCurrent = !isPastAllVisible && effectiveAllSteps[currentStep]?.id === step.id;
            const isActive = isCompleted || isCurrent;
            
            return (
              <Flex key={step.id} align="center" flexShrink={0}>
                <Box
                  w={{ base: 8, md: 10 }}
                  h={{ base: 8, md: 10 }}
                  borderRadius="full"
                  bg={isCompleted ? "green.500" : (isCurrent ? highlightColor : "gray.600")}
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  transition="all 0.3s"
                  flexShrink={0}
                  transform={isCurrent ? "scale(1.1)" : "scale(1)"}
                  boxShadow={isCurrent ? "0 0 0 4px rgba(251, 146, 60, 0.25)" : "none"}
                >
                  {isCompleted ? (
                    <Icon as={FaCheckCircle} color="white" boxSize={{ base: 4, md: 5 }} />
                  ) : (
                    <Text color="white" fontSize={{ base: "sm", md: "md" }} fontWeight="bold">
                      {step.number}
                    </Text>
                  )}
                </Box>
                <Text
                  ml={2}
                  fontSize={{ base: "xs", md: "sm" }}
                  fontWeight={isCurrent ? "bold" : "normal"}
                  color={isCompleted ? "green.500" : (isCurrent ? highlightColor : "gray.400")}
                  display={{ base: "none", lg: "block" }}
                  whiteSpace="nowrap"
                >
                  {t(step.label)}
                </Text>
                {index < VISIBLE_STEPS.length - 1 && (
                  <Box
                    w={{ base: 6, md: 10, lg: 12 }}
                    h={0.5}
                    bg={isCompleted ? "green.500" : (isCurrent ? highlightColor : "gray.600")}
                    ml={2}
                  />
                )}
              </Flex>
            );
          })}
        </HStack>
      </Box>

      {/* Content */}
      <Box
        p={{ base: 4, md: 6, lg: 8 }}
        minH={{ base: "50vh", md: "400px" }}
        bg="gray.800"
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="100%"
        overflow="hidden"
      >
        <Box w="100%" maxW="900px">
          <StepComponent key={`step-${currentStep}-${effectiveAllSteps[currentStep].id}`} {...stepProps} />
        </Box>
      </Box>

      {/* Footer */}
      <Box p={6} borderTopWidth="1px" borderColor="gray.700" bg="gray.850">
        <HStack justify="space-between">
          <Text fontSize="sm" color="gray.400">
            {visibleStepIndex >= 0 
              ? `Step ${visibleStepIndex + 1} of ${VISIBLE_STEPS.length}`
              : (currentStep > 0 ? 'Setting up wallet...' : '')
            }
          </Text>
          <HStack gap={4}>
            <Button
              variant="outline"
              onClick={handlePrevious}
              disabled={currentStep === 0}
              borderColor="gray.600"
              color="gray.300"
              _hover={{ bg: "gray.700" }}
            >
              Previous
            </Button>
            {/* Only show Next when not on special guarded steps */}
            {(effectiveAllSteps[currentStep].id !== 'create-or-recover' || flowType) &&
             effectiveAllSteps[currentStep].id !== 'bootloader' && (
              <Button
                colorScheme="orange"
                onClick={handleNext}
                size="lg"
              >
                {currentStep === effectiveAllSteps.length - 1 ? "Complete Setup" : "Next"}
              </Button>
            )}
          </HStack>
        </HStack>
      </Box>
    </Box>
  );
}