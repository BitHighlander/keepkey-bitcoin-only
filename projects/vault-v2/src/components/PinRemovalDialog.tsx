import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Text, HStack, Icon, VStack, Box, Spinner, SimpleGrid, Heading } from '@chakra-ui/react'
import { FaCircle, FaBackspace, FaTimes, FaExclamationTriangle } from 'react-icons/fa'
import { useTypedTranslation } from '../hooks/useTypedTranslation'

interface PinRemovalDialogProps {
  isOpen: boolean
  deviceId: string
  onSuccess: () => void
  onClose: () => void
}

// The KeepKey device shows this scrambled layout on its screen:
// 7 8 9
// 4 5 6
// 1 2 3
// We need to send these exact numbers when the user clicks each position
const PIN_MATRIX_LAYOUT = [7, 8, 9, 4, 5, 6, 1, 2, 3] as const

export const PinRemovalDialog = ({ isOpen, deviceId, onSuccess, onClose }: PinRemovalDialogProps) => {
  const { t } = useTypedTranslation('dialogs')
  const [pinPositions, setPinPositions] = useState<number[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handlePinButtonClick = useCallback((position: number) => {
    if (pinPositions.length >= 9) return // Max 9 digits
    
    setPinPositions(prev => [...prev, position])
    setError(null)
  }, [pinPositions])

  const handleBackspace = useCallback(() => {
    setPinPositions(prev => prev.slice(0, -1))
    setError(null)
  }, [])

  const handleClear = useCallback(() => {
    setPinPositions([])
    setError(null)
  }, [])

  const handleSubmit = async () => {
    if (pinPositions.length === 0) {
      setError('Please enter your PIN')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      console.log('🔐 Submitting PIN for removal with positions:', pinPositions)
      
      // Send PIN positions to backend for removal operation
      const result = await invoke('send_pin_for_removal', {
        deviceId,
        positions: new Uint8Array(pinPositions)
      })
      
      console.log('✅ PIN removal result:', result)
      
      if (result === true) {
        // Success - PIN was correct and removal completed
        onSuccess()
      } else {
        setError('Failed to disable PIN protection')
      }
      
    } catch (err: any) {
      console.error('❌ PIN removal submission failed:', err)
      
      const errorStr = String(err).toLowerCase()
      
      if (errorStr.includes('incorrect pin')) {
        setError('Incorrect PIN. Please try again.')
        setPinPositions([]) // Clear PIN for retry
      } else if (errorStr.includes('device not found') || errorStr.includes('not connected')) {
        setError('Device disconnected. Please reconnect and try again.')
        onClose()
      } else if (errorStr.includes('not in pin removal flow')) {
        setError('PIN removal flow was interrupted. Please try again.')
        onClose()
      } else {
        setError(`Error: ${err}`)
      }
    } finally {
      setIsLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <Box position="fixed" top={0} left={0} right={0} bottom={0} bg="blackAlpha.800" zIndex={99999} display="flex" alignItems="center" justifyContent="center">
      <Box bg="gray.800" color="white" borderRadius="xl" boxShadow="2xl" borderWidth="1px" borderColor="gray.700" overflow="hidden" maxW="420px" w="90%">
        <Box bg="gray.850" p={4} position="relative">
          <Heading fontSize="xl" fontWeight="bold" color="white" textAlign="center">
            {t('pin.remove.title')}
          </Heading>
          <Button position="absolute" right={2} top="50%" transform="translateY(-50%)" size="sm" variant="ghost" onClick={onClose} color="gray.400" _hover={{ color: 'white', bg: 'gray.700' }} borderRadius="md" disabled={isLoading}>
            <Icon as={FaTimes} />
          </Button>
        </Box>

        <Box p={5}>
          <VStack gap={4}>
            <VStack gap={1}>
              <Text color="gray.300" fontSize="sm" textAlign="center">
                {t('pin.remove.instructionOnComputer')}
              </Text>
              <Text color="gray.400" fontSize="xs" textAlign="center">
                {t('pin.unlock.clickPositions')}
              </Text>
            </VStack>

            <Box p={3} bg="gray.750" borderRadius="lg" borderWidth="1px" borderColor="gray.600">
              <HStack gap={1.5} justify="center">
                {Array.from({ length: Math.max(4, pinPositions.length) }, (_, i) => (
                  <Box key={i} w="10px" h="10px" borderRadius="full" bg={i < pinPositions.length ? 'green.400' : 'gray.600'} opacity={i < pinPositions.length ? 1 : 0.5} transition="all 0.2s" />
                ))}
              </HStack>
            </Box>

            <Box>
              <SimpleGrid columns={3} gap={2} w="200px" mx="auto">
                {PIN_MATRIX_LAYOUT.map((number, index) => (
                  <Button key={index} onClick={() => handlePinButtonClick(number)} size="md" h="50px" bg="gray.700" borderColor="gray.600" borderWidth="1px" color="gray.300" fontSize="lg" fontWeight="bold" position="relative" _hover={{ bg: 'gray.600', borderColor: 'green.500', transform: 'scale(1.05)' }} _active={{ bg: 'gray.500', transform: 'scale(0.95)' }} transition="all 0.15s" disabled={isLoading || pinPositions.length >= 9}>
                    <Icon as={FaCircle} boxSize={3} />
                  </Button>
                ))}
              </SimpleGrid>
              <Text fontSize="10px" color="gray.600" textAlign="center" mt={1}>
                {t('pin.unlock.numbersMatchNote')}
              </Text>
            </Box>

            <HStack gap={2} w="full" pt={2}>
              <Button onClick={handleBackspace} variant="outline" size="sm" borderColor="gray.600" color="gray.300" _hover={{ bg: 'gray.700', borderColor: 'gray.500' }} disabled={isLoading || pinPositions.length === 0} flex={1}>
                <Icon as={FaBackspace} mr={1} />
                {t('pin.unlock.buttons.back')}
              </Button>
              <Button onClick={handleClear} variant="outline" size="sm" borderColor="gray.600" color="gray.300" _hover={{ bg: 'gray.700', borderColor: 'gray.500' }} disabled={isLoading || pinPositions.length === 0} flex={1}>
                {t('pin.unlock.buttons.clear')}
              </Button>
              <Button onClick={handleSubmit} colorScheme="green" size="sm" _hover={{ transform: 'translateY(-1px)', boxShadow: 'lg' }} transition="all 0.2s" disabled={isLoading || pinPositions.length === 0} flex={2}>
                {isLoading ? <Spinner size="sm" /> : t('pin.remove.buttons.remove')}
              </Button>
            </HStack>

            {error && (
              <Box bg="red.900" borderColor="red.700" border="1px solid" p={3} borderRadius="md" w="full">
                <HStack gap={2} align="start">
                  <Icon as={FaExclamationTriangle} color="red.400" mt={0.5} boxSize={4} />
                  <VStack align="start" gap={1} flex={1}>
                    <Text fontSize="sm" color="red.100">{error}</Text>
                  </VStack>
                </HStack>
              </Box>
            )}
          </VStack>
        </Box>
      </Box>
    </Box>
  )
}