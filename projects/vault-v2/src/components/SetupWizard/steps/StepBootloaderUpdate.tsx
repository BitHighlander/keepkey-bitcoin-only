import { VStack, HStack, Text, Button, Box, Icon, Image, Spinner } from "@chakra-ui/react";
import { FaShieldAlt, FaExclamationTriangle } from "react-icons/fa";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import holdAndConnectSvg from '../../../assets/svg/hold-and-connect.svg';
import { useTypedTranslation } from '../../../hooks/useTypedTranslation';

interface StepBootloaderUpdateProps {
  deviceId: string;
  onNext: () => void;
  onBack: () => void;
  onBootloaderUpdateComplete?: () => void;
}


export function StepBootloaderUpdate({ deviceId, onNext, onBack, onBootloaderUpdateComplete }: StepBootloaderUpdateProps) {
  const [deviceStatus, setDeviceStatus] = useState<any>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showBootloaderInstructions, setShowBootloaderInstructions] = useState(false);
  const { t } = useTypedTranslation('setup');

  useEffect(() => {
    // Only check device status if we have a deviceId
    if (deviceId) {
      checkDeviceStatus();
    }
    
    // If showing bootloader instructions, periodically check if device entered bootloader mode
    let intervalId: NodeJS.Timeout | null = null;
    if (showBootloaderInstructions && deviceId) {
      intervalId = setInterval(() => {
        checkDeviceStatus();
      }, 2000); // Check every 2 seconds
    }
    
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [deviceId, showBootloaderInstructions]);

  const checkDeviceStatus = async () => {
    try {
      const status = await invoke<any>('get_device_status', { deviceId });
      
      // Check if status is null or undefined
      if (!status) {
        console.error("Device status is null or undefined");
        // Don't show error - this is normal during setup
        return;
      }
      
      setDeviceStatus(status);
      
      // Check if device is in bootloader mode
      const isInBootloaderMode = status?.features?.bootloader_mode || status?.features?.bootloaderMode || false;
      console.log('Bootloader mode check:', {
        hasFeatures: !!status?.features,
        bootloader_mode: status?.features?.bootloader_mode,
        bootloaderMode: status?.features?.bootloaderMode,
        isInBootloaderMode,
        needsBootloaderUpdate: status?.needsBootloaderUpdate
      });
      
      // Prefer backend evaluation flags
      const currentBootloaderVersion = status?.bootloaderCheck?.currentVersion;
      const backendNeedsUpdate = status?.bootloaderCheck?.needsUpdate === true || status?.needsBootloaderUpdate === true;
      
      console.log("Bootloader check:", {
        currentVersion: currentBootloaderVersion,
        needsUpdate: backendNeedsUpdate
      });
      
      if (backendNeedsUpdate) {
        console.log("Bootloader update needed: v" + currentBootloaderVersion + " → v2.1.5");
        // Show update UI
        if (!isInBootloaderMode) {
          console.log("Device needs bootloader update but not in bootloader mode");
          setShowBootloaderInstructions(true);
        } else if (isInBootloaderMode && showBootloaderInstructions) {
          console.log("Device is now in bootloader mode for update");
          setShowBootloaderInstructions(false);
        }
        return; // Stay on this step
      }
      
      // Bootloader is good, move to next step
      if (!backendNeedsUpdate) {
        console.log("Bootloader is up to date, proceeding to next step");
        onNext();
        return;
      } else if (!isInBootloaderMode) {
        // Device needs bootloader update but is not in bootloader mode
        console.log("Device needs bootloader update but not in bootloader mode");
        setShowBootloaderInstructions(true);
      } else if (isInBootloaderMode && showBootloaderInstructions) {
        // Device has entered bootloader mode, hide instructions
        console.log("Device is now in bootloader mode");
        setShowBootloaderInstructions(false);
      }
    } catch (err) {
      console.error("Failed to get device status:", err);
      // Don't show error - this is normal during setup
    }
  };

  const handleBootloaderUpdate = async () => {
    // First check if device is in bootloader mode
    const isInBootloaderMode = deviceStatus?.features?.bootloader_mode || deviceStatus?.features?.bootloaderMode || false;
    
    if (!isInBootloaderMode) {
      setShowBootloaderInstructions(true);
      return;
    }
    
    setIsUpdating(true);
    
    try {
      // Start bootloader update
      const success = await invoke('update_device_bootloader', {
        deviceId,
        targetVersion: deviceStatus.bootloaderCheck?.latestVersion || ''
      });
      
      // Notify that bootloader update completed
      if (onBootloaderUpdateComplete) {
        onBootloaderUpdateComplete();
      }
      
      // Wait longer for device to reconnect after bootloader update
      console.log('🔄 Bootloader update complete, waiting for device to reconnect...');
      setTimeout(() => {
        onNext();
      }, 5000); // Increased to 5 seconds
      
    } catch (err) {
      console.error("Failed to update bootloader:", err);
      const errorMsg = String(err);
      
      // Check if the error is because device is not in bootloader mode
      if (errorMsg.includes('bootloader mode') || errorMsg.includes('Bootloader mode')) {
        setShowBootloaderInstructions(true);
      }
      // Don't show any errors to the user
      setIsUpdating(false);
    }
  };


  if (!deviceStatus) {
    return (
      <VStack gap={6} w="100%" maxW="500px">
        <HStack gap={3}>
          <Spinner size="sm" color="green.500" />
          <Text color="gray.400">Follow Directions on device...</Text>
        </HStack>
      </VStack>
    );
  }

  // If showing bootloader instructions
  if (showBootloaderInstructions) {
    return (
      <Box w="100%">
        <HStack 
          gap={{ base: 4, md: 8 }} 
          align="flex-start"
          flexDirection={{ base: "column", lg: "row" }}
          w="100%"
        >
          {/* Left side - Instructions and image */}
          <VStack gap={4} flex={{ base: "none", lg: 1 }} w={{ base: "100%", lg: "auto" }}>
            <HStack gap={2}>
              <Icon as={FaExclamationTriangle} color="yellow.500" boxSize={6} />
              <Text fontSize="xl" fontWeight="bold" color="white">
                {t('bootloaderUpdate.enterFirmwareUpdateMode')}
              </Text>
            </HStack>

            <Text fontSize="sm" color="gray.300" textAlign="center">
              {t('bootloaderUpdate.toUpdateFirmware')}
            </Text>

            <Box display="flex" justifyContent="center" py={2}>
              <Image
                src={holdAndConnectSvg}
                alt={t('bootloaderUpdate.holdButtonWhileConnecting')}
                maxW={{ base: "200px", md: "240px" }}
                height="auto"
              />
            </Box>
          </VStack>

          {/* Right side - Steps and actions */}
          <VStack gap={4} flex={{ base: "none", lg: 1 }} w={{ base: "100%", lg: "auto" }}>
            <VStack align="stretch" gap={1} bg="gray.700" p={4} borderRadius="md" fontSize="sm" w="100%">
              <Text fontWeight="semibold" color="yellow.300">{t('bootloaderUpdate.quickSteps')}</Text>
              <Text color="gray.200">{t('bootloaderUpdate.unplugDevice')}</Text>
              <Text color="gray.200">{t('bootloaderUpdate.holdButtonAndPlug')}</Text>
              <Text color="gray.200">{t('bootloaderUpdate.followDirections')}</Text>
              <Text color="gray.200">{t('bootloaderUpdate.releaseButton')}</Text>
            </VStack>

          </VStack>
        </HStack>
      </Box>
    );
  }

  // Check if this is an old bootloader that MUST be updated
  const currentBootloaderVersion = deviceStatus?.bootloaderCheck?.currentVersion || "unknown";
  const isOldBootloader = deviceStatus?.bootloaderCheck?.needsUpdate === true ||
                         currentBootloaderVersion.startsWith("1.") ||
                         ["2.0.0","2.0.1","2.0.2","2.0.3","2.0.4"].includes(currentBootloaderVersion);

  return (
    <Box w="100%">
      <HStack 
        gap={{ base: 4, md: 8 }} 
        align="flex-start"
        flexDirection={{ base: "column", lg: "row" }}
      >
        {/* Left side - Icon and status */}
        <VStack gap={4} flex={{ base: "none", lg: 1 }} w={{ base: "100%", lg: "auto" }}>
          <Icon as={FaShieldAlt} 
                boxSize={{ base: 12, md: 16 }} 
                color="blue.500" />
          
          <VStack gap={2}>
            <Text fontSize={{ base: "xl", md: "2xl" }} fontWeight="bold" color="white" textAlign="center">
              {t('bootloaderUpdate.firmwareUpdater')}
            </Text>
            {isOldBootloader ? (
              <>
                <Text fontSize={{ base: "sm", md: "md" }} color="blue.400" textAlign="center">
                  {t('bootloaderUpdate.updateAvailableFor', { version: currentBootloaderVersion })}
                </Text>
                <Text fontSize="xs" color="gray.400" textAlign="center">
                  {t('bootloaderUpdate.letsUpdateToLatest')}
                </Text>
              </>
            ) : deviceStatus.needsBootloaderUpdate ? (
              <Text fontSize={{ base: "sm", md: "md" }} color="gray.400" textAlign="center">
                Your KeepKey bootloader needs to be updated!
              </Text>
            ) : (
              <Text fontSize={{ base: "sm", md: "md" }} color="green.400" textAlign="center">
                Your bootloader is up to date!
              </Text>
            )}
          </VStack>
          
          {/* Update info box for old bootloaders */}
          {isOldBootloader && (
            <Box w="100%" p={4} bg="blue.900" borderRadius="lg" borderWidth="2px" borderColor="blue.500">
              <VStack gap={2} align="start">
                <Text color="blue.300" fontWeight="bold" fontSize="sm">
                  {t('bootloaderUpdate.updateRequired')}
                </Text>
                <Text fontSize="xs" color="blue.200">
                  • {t('bootloaderUpdate.yourDeviceHasBootloader', { version: currentBootloaderVersion })}
                </Text>
                <Text fontSize="xs" color="blue.200">
                  • {t('bootloaderUpdate.weWillUpdateTo', { version: '2.1.5' })}
                </Text>
                <Text fontSize="xs" color="blue.200">
                  • {t('bootloaderUpdate.thisIsRequiredStep')}
                </Text>
              </VStack>
            </Box>
          )}
        </VStack>

        {/* Right side - Details and actions */}
        <VStack gap={4} flex={{ base: "none", lg: 1 }} w={{ base: "100%", lg: "auto" }}>
          {deviceStatus.bootloaderCheck && (
            <Box w="100%" p={4} bg="gray.700" borderRadius="lg">
              <HStack gap={8} justify="space-between">
                <VStack gap={1} align="start">
                  <Text fontSize="xs" color="gray.400" textTransform="uppercase">
                    {t('bootloaderUpdate.currentVersion')}
                  </Text>
                  <Text fontSize="lg" color="white" fontWeight="bold">
                    v{deviceStatus.bootloaderCheck.currentVersion}
                  </Text>
                </VStack>
                <VStack gap={1} align="start">
                  <Text fontSize="xs" color="gray.400" textTransform="uppercase">
                    {t('bootloaderUpdate.latestVersion')}
                  </Text>
                  <Text fontSize="lg" color="green.400" fontWeight="bold">
                    v{deviceStatus.bootloaderCheck.latestVersion}
                  </Text>
                </VStack>
              </HStack>
            </Box>
          )}


          {isUpdating && (
            <Box w="100%">
              <Box mb={3} p={3} bg="blue.900" borderColor="blue.500" borderWidth={1} borderRadius="md">
                <HStack align="start">
                  <Icon as={FaExclamationTriangle} color="yellow.400" mt={1} />
                  <Text fontSize="sm" color="gray.200">
                    On the KeepKey, it will ask you to verify backup. We will do this after updating, hold the button to skip this for now to continue.
                  </Text>
                </HStack>
              </Box>
              <VStack gap={4}>
                <Text fontSize="xl" fontWeight="bold" color="orange.500">
                  Follow directions on device
                </Text>
                <Text fontSize="md" color="gray.400" textAlign="center">
                  Your KeepKey will guide you through the update process.
                </Text>
                <Text fontSize="sm" color="gray.400">
                  Do not disconnect your device during the update.
                </Text>
              </VStack>
            </Box>
          )}

          <VStack gap={3} w="100%">
            {(deviceStatus.bootloaderCheck?.needsUpdate || deviceStatus.needsBootloaderUpdate || isOldBootloader) && !isUpdating && (
              <Button
                colorScheme="blue"
                size="lg"
                w="100%"
                onClick={handleBootloaderUpdate}
                loading={isUpdating}
              >
                Update Bootloader
              </Button>
            )}
            {!deviceStatus.needsBootloaderUpdate && !isOldBootloader && (
              <Text fontSize="sm" color="green.400" textAlign="center">
                ✅ Bootloader verified - v{currentBootloaderVersion}
              </Text>
            )}
          </VStack>
        </VStack>
      </HStack>
    </Box>
  );
}