import { useState } from 'react';
import { Box, Button, VStack, Text, useDisclosure, Drawer, DrawerOverlay, DrawerContent, DrawerHeader, DrawerBody, DrawerCloseButton } from '@chakra-ui/react';
import { deviceLogger } from '../utils/deviceLogger';

export const DebugPanel = () => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [isVisible, setIsVisible] = useState(false);
  
  // Toggle debug panel with keyboard shortcut (Ctrl+Shift+D)
  useState(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        setIsVisible(prev => !prev);
      }
    };
    
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  });
  
  const exportLogs = () => {
    const logs = deviceLogger.exportLogs();
    const blob = new Blob([logs], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `keepkey-debug-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  const clearLogs = () => {
    if (confirm('Are you sure you want to clear all logs?')) {
      deviceLogger.clearLogs();
    }
  };
  
  if (!isVisible) {
    return null;
  }
  
  return (
    <>
      <Box
        position="fixed"
        bottom={4}
        right={4}
        zIndex={9999}
        bg="gray.800"
        p={2}
        borderRadius="md"
        borderWidth="1px"
        borderColor="gray.600"
      >
        <VStack spacing={2}>
          <Text fontSize="xs" color="gray.400">Debug Panel (Ctrl+Shift+D)</Text>
          <Button size="xs" colorScheme="blue" onClick={onOpen}>
            View Logs
          </Button>
          <Button size="xs" colorScheme="green" onClick={exportLogs}>
            Export Logs
          </Button>
          <Button size="xs" colorScheme="red" onClick={clearLogs}>
            Clear Logs
          </Button>
        </VStack>
      </Box>
      
      <Drawer isOpen={isOpen} placement="right" onClose={onClose} size="lg">
        <DrawerOverlay />
        <DrawerContent bg="gray.900">
          <DrawerCloseButton />
          <DrawerHeader color="white">Device Connection Logs</DrawerHeader>
          <DrawerBody>
            <Box
              as="pre"
              fontSize="xs"
              color="gray.300"
              bg="black"
              p={4}
              borderRadius="md"
              overflowY="auto"
              maxH="80vh"
              fontFamily="mono"
            >
              {deviceLogger.exportLogs()}
            </Box>
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
};