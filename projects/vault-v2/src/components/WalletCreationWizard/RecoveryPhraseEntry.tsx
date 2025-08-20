import { useState, useEffect, useRef } from "react";
import { useTypedTranslation } from "../../hooks/useTypedTranslation";
import { invoke } from "@tauri-apps/api/core";
import {
  Box,
  Heading,
  VStack,
  HStack,
  Text,
  Button,
  Input,
} from "@chakra-ui/react";

interface RecoveryPhraseEntryProps {
  sessionId: string;
  wordCount: number;
  onComplete: () => void;
  onError: (error: string) => void;
  onBack?: () => void;
}

interface RecoveryProgress {
  word_pos: number;
  character_pos: number;
  auto_completed: boolean;
  is_complete: boolean;
  error?: string;
}

export function RecoveryPhraseEntry({ 
  sessionId, 
  wordCount, 
  onComplete, 
  onError, 
  onBack 
}: RecoveryPhraseEntryProps) {
  const { t } = useTypedTranslation('setup');
  const [currentWord, setCurrentWord] = useState(0);
  const [currentChar, setCurrentChar] = useState(0);
  const [characterInputs, setCharacterInputs] = useState(['', '', '', '']);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAutoCompleted, setIsAutoCompleted] = useState(false);

  const inputRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  // Focus the current character input
  useEffect(() => {
    if (currentChar < 4 && inputRefs[currentChar]?.current) {
      inputRefs[currentChar].current?.focus();
    }
  }, [currentChar]);

  const handleCharacterInput = async (index: number, value: string) => {
    if (isProcessing) return;

    // Only allow letters
    const letter = value.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (letter && letter !== value.toLowerCase()) {
      return; // Invalid character
    }

    const newInputs = [...characterInputs];
    newInputs[index] = letter;
    setCharacterInputs(newInputs);

    if (letter) {
      setIsProcessing(true);
      try {
        const result = await invoke<RecoveryProgress>('send_recovery_character', {
          sessionId,
          character: letter,
          action: null,
        });

        setCurrentWord(result.word_pos);
        setCurrentChar(result.character_pos);
        setIsAutoCompleted(result.auto_completed);

        if (result.is_complete) {
          onComplete();
        }
      } catch (error) {
        console.error('Failed to send character:', error);
        onError(`Failed to send character: ${error}`);
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const handleBackspace = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      const result = await invoke<RecoveryProgress>('send_recovery_character', {
        sessionId,
        character: null,
        action: 'Delete',
      });

      setCurrentWord(result.word_pos);
      setCurrentChar(result.character_pos);
      
      // Update local input state
      const newInputs = [...characterInputs];
      if (currentChar > 0) {
        newInputs[currentChar - 1] = '';
      }
      setCharacterInputs(newInputs);
    } catch (error) {
      console.error('Failed to delete character:', error);
      onError(`Failed to delete character: ${error}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleNextWord = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      const result = await invoke<RecoveryProgress>('send_recovery_character', {
        sessionId,
        character: null,
        action: 'Space',
      });

      setCurrentWord(result.word_pos);
      setCurrentChar(result.character_pos);
      setCharacterInputs(['', '', '', '']);
      setIsAutoCompleted(false);

      if (result.is_complete) {
        onComplete();
      }
    } catch (error) {
      console.error('Failed to move to next word:', error);
      onError(`Failed to move to next word: ${error}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'Backspace' && characterInputs[index] === '' && index > 0) {
      // Move to previous input on backspace
      inputRefs[index - 1]?.current?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (currentWord < wordCount - 1) {
        handleNextWord();
      } else {
        // Last word - complete recovery
        handleComplete();
      }
    } else if (event.key === 'Backspace' && characterInputs[index] === '') {
      handleBackspace();
    }
  };

  const handleComplete = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      const result = await invoke<RecoveryProgress>('send_recovery_character', {
        sessionId,
        character: null,
        action: 'Done',
      });

      if (result.is_complete) {
        onComplete();
      }
    } catch (error) {
      console.error('Failed to complete recovery:', error);
      onError(`Failed to complete recovery: ${error}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const progressPercent = ((currentWord + 1) / wordCount) * 100;
  const canProceed = currentChar >= 3 || isAutoCompleted;

  return (
    <div style={{ 
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
    }}>
      <Box 
        maxW="lg" 
        bg="gray.800" 
        color="white" 
        p={8} 
        borderRadius="lg"
        boxShadow="xl"
        w="90%"
      >
        <Heading size="lg" textAlign="center" mb={2}>
          {t('recovery.enterYourRecoverySentence', 'Enter Your Recovery Sentence')}
        </Heading>
        
        <Text fontSize="sm" color="gray.400" textAlign="center" mb={6}>
          {t('recovery.enterInstructions', 'Using the scrambled keyboard legend on your KeepKey, enter the first 4 letters of each word. If there are less than 4 letters in the word, press Enter, hit the space bar, or click next when you\'re done typing.')}
        </Text>
        
        <VStack gap={6}>
          {/* Progress */}
          <Box w="100%">
            <HStack justify="space-between" mb={2}>
              <Text fontSize="sm" color="gray.300">
                {t('recovery.wordOf', { defaultValue: 'Word {{current}} of {{total}}', current: currentWord + 1, total: wordCount })}
              </Text>
              <Text fontSize="sm" color="gray.300">
                {t('recovery.percentComplete', { defaultValue: '{{percent}}% Complete', percent: Math.round(progressPercent) })}
              </Text>
            </HStack>
            <Box
              w="100%"
              h="6px"
              bg="gray.700"
              borderRadius="md"
              overflow="hidden"
            >
              <Box
                h="100%"
                bg="blue.500"
                borderRadius="md"
                transition="width 0.3s"
                style={{ width: `${progressPercent}%` }}
              />
            </Box>
          </Box>

          {/* Word counter circle */}
          <Box
            w="60px"
            h="60px"
            borderRadius="full"
            bg="gray.700"
            borderWidth="2px"
            borderColor="gray.500"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Text fontSize="xl" fontWeight="bold">
              {String(currentWord + 1).padStart(2, '0')}
            </Text>
          </Box>

          {/* Character inputs */}
          <HStack gap={4}>
            {characterInputs.map((value, index) => (
              <Input
                key={index}
                ref={inputRefs[index]}
                value={value}
                onChange={(e) => handleCharacterInput(index, e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                maxLength={1}
                w="60px"
                h="60px"
                textAlign="center"
                fontSize="2xl"
                fontWeight="bold"
                bg={index < currentChar ? "blue.600" : "gray.700"}
                borderColor={index === currentChar ? "blue.400" : "gray.600"}
                borderWidth="2px"
                _focus={{
                  borderColor: "blue.400",
                  boxShadow: "0 0 0 1px #3182ce"
                }}
                _hover={{
                  borderColor: index === currentChar ? "blue.400" : "gray.500"
                }}
                disabled={isProcessing || index !== currentChar}
              />
            ))}
          </HStack>

          {isAutoCompleted && (
            <Text fontSize="sm" color="green.400" textAlign="center">
              {t('recovery.wordAutoCompleted', '✓ Word auto-completed by device')}
            </Text>
          )}

          {/* Action buttons */}
          <HStack gap={4} w="100%">
            <Button
              onClick={handleBackspace}
              variant="outline"
              size="lg"
              flex={1}
              disabled={isProcessing || (currentChar === 0 && currentWord === 0)}
              borderColor="gray.500"
              color="gray.300"
              _hover={{
                borderColor: "gray.400",
                color: "white"
              }}
            >
              {t('recovery.backspace', 'Backspace')}
            </Button>

            <Button
              onClick={currentWord < wordCount - 1 ? handleNextWord : handleComplete}
              colorScheme="blue"
              size="lg"
              flex={2}
              disabled={isProcessing || !canProceed}
            >
              {isProcessing ? t('recovery.processing', 'Processing...') : 
               currentWord < wordCount - 1 ? t('recovery.nextWord', 'Next Word') : t('recovery.completeRecovery', 'Complete Recovery')}
            </Button>
          </HStack>

          {onBack && (
            <Button
              onClick={onBack}
              variant="ghost"
              size="sm"
              color="gray.400"
              _hover={{
                color: "white"
              }}
            >
              {t('recovery.cancelRecovery', 'Cancel Recovery')}
            </Button>
          )}
        </VStack>
      </Box>
    </div>
  );
} 