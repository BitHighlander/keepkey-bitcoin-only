import { useState, useEffect, useRef } from "react";
import { useTypedTranslation } from "../../hooks/useTypedTranslation";
import {
  Box,
  Heading,
  VStack,
  HStack,
  Text,
  Button,
} from "@chakra-ui/react";

interface RecoverySettingsProps {
  onComplete: (settings: RecoverySettings) => void;
  onBack?: () => void;
  isLoading?: boolean;
  error?: string | null;
}

export interface RecoverySettings {
  wordCount: 12 | 18 | 24;
  usePassphrase: boolean; // Always false, option removed from UI
}

export function RecoverySettings({ 
  onComplete, 
  onBack, 
  isLoading = false, 
  error 
}: RecoverySettingsProps) {
  const { t } = useTypedTranslation('setup');
  const [wordCount, setWordCount] = useState<12 | 18 | 24>(12);
  // Passphrase option removed - always false
  const usePassphrase = false;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleSubmit = () => {
    const settings: RecoverySettings = {
      wordCount,
      usePassphrase, // Always false
    };
    onComplete(settings);
  };

  // Enter key should submit (same as pressing Next) on this screen
  useEffect(() => {
    // Signal to the wizard to not auto-advance while this modal is open
    (window as any).KEEPKEY_MODAL_ACTIVE = true;
    // Focus the container so it can catch key events
    containerRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      // Ensure other handlers don't run
      (e as any).stopImmediatePropagation?.();
      e.stopPropagation();
      if (!isLoading) {
        handleSubmit();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      (window as any).KEEPKEY_MODAL_ACTIVE = false;
    };
  }, [isLoading, wordCount]);

  return (
    <div 
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !isLoading) {
          e.preventDefault();
          (e as any).stopImmediatePropagation?.();
          e.stopPropagation();
          handleSubmit();
        }
      }}
      style={{ 
      position: 'fixed', 
      top: 0, 
      left: 0, 
      right: 0, 
      bottom: 0, 
      backgroundColor: 'rgba(0, 0, 0, 0.8)', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center', 
      zIndex: 9999 
    }}
    >
      <Box 
        maxW="md" 
        bg="gray.800" 
        color="white" 
        p={8} 
        borderRadius="lg"
        boxShadow="xl"
      >
        <Heading size="lg" textAlign="center" mb={6}>
          {t('recovery.title')}
        </Heading>
        
        <VStack gap={6}>
          {error && (
            <Box bg="red.900" color="white" p={4} borderRadius="md" w="100%">
              <Text>{error}</Text>
            </Box>
          )}

          <Box w="100%">
            <Text fontSize="lg" fontWeight="semibold" mb={4}>
              {t('recovery.sentenceLength')}
            </Text>
            <HStack gap={3} w="100%">
              <Box
                flex={1}
                p={3}
                borderRadius="md"
                bg={wordCount === 12 ? "blue.600" : "gray.700"}
                borderWidth="2px"
                borderColor={wordCount === 12 ? "blue.400" : "gray.600"}
                cursor="pointer"
                transition="all 0.2s"
                onClick={() => setWordCount(12)}
                _hover={{
                  borderColor: wordCount === 12 ? "blue.400" : "gray.500",
                  bg: wordCount === 12 ? "blue.600" : "gray.650"
                }}
              >
                <Text fontSize="md" textAlign="center" fontWeight={wordCount === 12 ? "bold" : "normal"}>
                  {t('recovery.twelveWords')}
                </Text>
              </Box>
              <Box
                flex={1}
                p={3}
                borderRadius="md"
                bg={wordCount === 18 ? "blue.600" : "gray.700"}
                borderWidth="2px"
                borderColor={wordCount === 18 ? "blue.400" : "gray.600"}
                cursor="pointer"
                transition="all 0.2s"
                onClick={() => setWordCount(18)}
                _hover={{
                  borderColor: wordCount === 18 ? "blue.400" : "gray.500",
                  bg: wordCount === 18 ? "blue.600" : "gray.650"
                }}
              >
                <Text fontSize="md" textAlign="center" fontWeight={wordCount === 18 ? "bold" : "normal"}>
                  {t('recovery.eighteenWords')}
                </Text>
              </Box>
              <Box
                flex={1}
                p={3}
                borderRadius="md"
                bg={wordCount === 24 ? "blue.600" : "gray.700"}
                borderWidth="2px"
                borderColor={wordCount === 24 ? "blue.400" : "gray.600"}
                cursor="pointer"
                transition="all 0.2s"
                onClick={() => setWordCount(24)}
                _hover={{
                  borderColor: wordCount === 24 ? "blue.400" : "gray.500",
                  bg: wordCount === 24 ? "blue.600" : "gray.650"
                }}
              >
                <Text fontSize="md" textAlign="center" fontWeight={wordCount === 24 ? "bold" : "normal"}>
                  {t('recovery.twentyFourWords')}
                </Text>
              </Box>
            </HStack>
            <Text fontSize="sm" color="gray.400" mt={3}>
              {t('recovery.enterPhraseHelp', { count: wordCount, defaultValue: 'Enter your {{count}}-word recovery phrase to restore your wallet.' })}
            </Text>
          </Box>

          <VStack gap={3} w="100%">
            <Button
              onClick={handleSubmit}
              colorScheme="blue"
              size="lg"
              w="100%"
              disabled={isLoading}
            >
              {isLoading ? t('recovery.startingRecovery') : t('recovery.recoverWallet')}
            </Button>
            
            {onBack && (
              <Button
                onClick={onBack}
                variant="outline"
                size="lg"
                w="100%"
                disabled={isLoading}
                borderColor="gray.500"
                color="gray.300"
                _hover={{
                  borderColor: "gray.400",
                  color: "white"
                }}
              >
                {t('recovery.back')}
              </Button>
            )}
          </VStack>
        </VStack>
      </Box>
    </div>
  );
} 