import { Box, Text, HStack, Spinner } from '@chakra-ui/react';
import { keyframes } from '@emotion/react';
import { SiBitcoin } from 'react-icons/si';
import { Portfolio } from '../Portfolio';
import { KeepKeyUILogo } from '../logo/keepkey-ui';
import { useState } from 'react';

interface VaultViewProps {
  onNavigate?: (action: 'send' | 'receive') => void;
}

// Animation for the KeepKey logo
const pulseGlow = keyframes`
  0% { 
    opacity: 0.6;
    transform: scale(1);
    filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.3));
  }
  50% { 
    opacity: 0.9;
    transform: scale(1.05);
    filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.5));
  }
  100% { 
    opacity: 0.6;
    transform: scale(1);
    filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.3));
  }
`;

// Animation for the Bitcoin logo when syncing
const syncSpin = keyframes`
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
`;

export const VaultView = ({ onNavigate }: VaultViewProps) => {
  const [isSyncing, setIsSyncing] = useState(false);

  // Handle Bitcoin logo click to trigger sync
  const handleBitcoinLogoClick = async () => {
    if (isSyncing) return; // Prevent multiple clicks during sync
    
    setIsSyncing(true);
    console.log('🔄 VaultView: Bitcoin logo clicked, triggering sync...');
    
    try {
      // Call sync device API directly
      const response = await fetch('http://localhost:1646/api/v2/sync-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.ok) {
        const syncResult = await response.json();
        console.log('✅ VaultView: Device sync successful:', syncResult);
        
        // Force portfolio to reload after successful sync
        window.location.reload();
      } else {
        console.error('❌ VaultView: Sync failed:', response.status);
      }
    } catch (error) {
      console.error('❌ VaultView: Sync error:', error);
    } finally {
      // Reset syncing state after 2 seconds minimum
      setTimeout(() => setIsSyncing(false), 2000);
    }
  };

  return (
    <Box height="100%" position="relative">
      {/* Bitcoin CAIP Info - Top Right (now clickable) */}
      <Box
        position="absolute"
        top={3}
        right={3}
        zIndex={10}
        bg="rgba(0, 0, 0, 0.8)"
        borderRadius="md"
        px={2}
        py={1}
        backdropFilter="blur(10px)"
        border="1px solid rgba(255, 255, 255, 0.1)"
        cursor="pointer"
        transition="all 0.2s ease"
        _hover={{
          bg: "rgba(0, 0, 0, 0.9)",
          border: "1px solid rgba(255, 165, 0, 0.3)",
          transform: "scale(1.02)"
        }}
        _active={{
          transform: "scale(0.98)"
        }}
        onClick={handleBitcoinLogoClick}
        title={isSyncing ? "Syncing device..." : "Click to sync device"}
      >
        <HStack gap={2} align="center">
          <Box 
            color="orange.400" 
            fontSize="xs"
            animation={isSyncing ? `${syncSpin} 1s linear infinite` : undefined}
          >
            {isSyncing ? <Spinner size="xs" color="orange.400" /> : <SiBitcoin />}
          </Box>
          <Text fontSize="xs" color="gray.300" fontFamily="mono" fontWeight="bold">
            bip122:000000000019d6689c085ae165831e93
          </Text>
          <Text fontSize="xs" color={isSyncing ? "orange.300" : "gray.400"}>
            {isSyncing ? "(syncing...)" : "(bitcoin only)"}
          </Text>
        </HStack>
      </Box>

      {/* KeepKey Logo Animation - Bottom Left */}
      <Box
        position="absolute"
        bottom={2}
        left={2}
        zIndex={10}
        width="50px"
        height="50px"
        animation={`${pulseGlow} 3s ease-in-out infinite`}
      >
        <KeepKeyUILogo />
      </Box>

      {/* Main Content - Portfolio with transparent background */}
      <Box height="100%" bg="transparent">
        <Portfolio onNavigate={onNavigate} />
      </Box>
    </Box>
  );
}; 