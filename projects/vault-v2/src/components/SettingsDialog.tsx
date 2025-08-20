import { Tabs, VStack, Text, Button, Icon, Box, HStack, Flex, Link, Stack, Input, Textarea, Spinner, Switch } from '@chakra-ui/react'
import { 
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogCloseTrigger
} from './ui/dialog'
import { LuSettings, LuMonitor, LuCpu, LuNetwork, LuFileText } from 'react-icons/lu'
import { FaCog, FaLink, FaCopy, FaCheck, FaTimes, FaUsb, FaLock, FaGlobe, FaDollarSign, FaDownload, FaTrash, FaSyncAlt, FaSearch, FaFilter, FaFolder, FaBitcoin } from 'react-icons/fa'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageSwitcher } from './LanguageSwitcher'
import { useSettings } from '../contexts/SettingsContext'

import { KeepKeyDeviceList } from './KeepKeyDeviceList'
import { BootloaderUpdateDialog } from './BootloaderUpdateDialog'
import { FirmwareUpdateDialog } from './FirmwareUpdateDialog'
import SeedVerificationWizard from './SeedVerificationWizard/SeedVerificationWizard'
import { BitcoinSettings } from './BitcoinSettings'
import type { DeviceStatus } from '../types/device'
import { invoke } from '@tauri-apps/api/core'
import holdAndConnectSvg from '../assets/svg/hold-and-connect.svg'
import { useFirmwareUpdateWizard, useWalletCreationWizard } from '../contexts/DialogContext'

interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
}

interface LogEntry {
  timestamp: string
  direction: string
  device_id?: string
  request_id?: string
  request_type?: string
  message_type?: string
  success?: boolean
  data: any
  error?: string
}

export const SettingsDialog = ({ isOpen, onClose }: SettingsDialogProps) => {
  const { t } = useTranslation(['settings', 'common'])
  const { currency, numberFormat, setCurrency, setNumberFormat } = useSettings()
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [showBootloaderUpdate, setShowBootloaderUpdate] = useState(false)
  const [showFirmwareUpdate, setShowFirmwareUpdate] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null)
  
  // Copy state for URLs
  const [hasCopiedMcp, setHasCopiedMcp] = useState(false)
  const [hasCopiedRest, setHasCopiedRest] = useState(false)
  
  // API enable/disable state
  const [apiEnabled, setApiEnabled] = useState(false)
  const [apiStatus, setApiStatus] = useState<any>(null)
  const [isTogglingApi, setIsTogglingApi] = useState(false)
  
  // Seed verification wizard state
  const [verificationWizardOpen, setVerificationWizardOpen] = useState(false)
  const [verificationDeviceId, setVerificationDeviceId] = useState<string | null>(null)
  const [verificationDeviceLabel, setVerificationDeviceLabel] = useState<string | null>(null)
  
  // Log viewer state
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [logFilter, setLogFilter] = useState<string>('all') // 'all', 'requests', 'responses', 'errors'
  const [searchTerm, setSearchTerm] = useState<string>('')
  const [logLimit, setLogLimit] = useState<number>(50)
  const [logPath, setLogPath] = useState<string>('')
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false)
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  
  // Currency and format settings are now handled by SettingsContext
  
  // Toast notification state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info'; visible: boolean }>({
    message: '',
    type: 'info',
    visible: false
  })
  const [isDownloading, setIsDownloading] = useState(false)
  
  const firmwareWizard = useFirmwareUpdateWizard()
  const walletCreationWizard = useWalletCreationWizard()
  
  // Load API status
  const loadApiStatus = async () => {
    try {
      const enabled = await invoke<boolean>('get_api_enabled')
      const status = await invoke<any>('get_api_status')
      setApiEnabled(enabled)
      setApiStatus(status)
      console.log('API Status loaded:', { enabled, status })
    } catch (error) {
      console.error('Failed to load API status:', error)
    }
  }
  
  // Toggle API enable/disable
  const handleToggleApi = async (enabled: boolean) => {
    if (isTogglingApi) return
    
    setIsTogglingApi(true)
    try {
      console.log('Toggling API to:', enabled)
      
      // Set the API enabled preference
      await invoke('set_api_enabled', { enabled })
      setApiEnabled(enabled)
      
      // Show toast about restart
      const action = enabled ? 'enabled' : 'disabled'
      showToast(`API ${action}. Restarting application...`, 'info')
      
      // Wait a moment for the toast to show, then restart
      setTimeout(async () => {
        try {
          await invoke('restart_app')
        } catch (error) {
          console.error('Failed to restart app:', error)
          // Fallback message if restart fails
          showToast('Please restart the application manually to apply changes.', 'error')
        }
      }, 1000)
      
    } catch (error) {
      console.error('Failed to toggle API:', error)
      showToast(`Failed to ${enabled ? 'enable' : 'disable'} API: ${error}`, 'error')
      // Revert the state
      setApiEnabled(!enabled)
      setIsTogglingApi(false)
    }
  }
  
  // URL copy handlers
  const handleCopyMcp = () => {
    navigator.clipboard.writeText("http://127.0.0.1:1646/mcp");
    setHasCopiedMcp(true);
    setTimeout(() => setHasCopiedMcp(false), 2000);
  };

  const handleCopyRest = () => {
    navigator.clipboard.writeText("http://127.0.0.1:1646/docs");
    setHasCopiedRest(true);
    setTimeout(() => setHasCopiedRest(false), 2000);
  };
  
  // Define fetchDeviceStatus function outside of useEffect
  const fetchDeviceStatus = async (deviceId = selectedDeviceId) => {
  console.debug('[SettingsDialog] fetchDeviceStatus called with deviceId:', deviceId);
    if (deviceId) {
      try {
        console.log('Fetching device status for deviceId:', deviceId)
        const status = await invoke<DeviceStatus | null>('get_device_status', { 
          deviceId: deviceId 
        })
        if (status) {
          console.log('Received device status:', status)
          setDeviceStatus(status)
        } else {
          console.warn('Received null device status')
        }
      } catch (error) {
        console.error('Failed to get device status:', error)
      }
    } else {
      console.warn('No deviceId provided for fetchDeviceStatus')
    }
  }
  
  // Fetch device status when a device is selected
  useEffect(() => {
    fetchDeviceStatus()
  }, [selectedDeviceId])

  // Remove firmware version fetching - backend handles this

  const handleBootloaderUpdate = async (deviceId: string) => {
    console.log('handleBootloaderUpdate called with deviceId:', deviceId)
    setSelectedDeviceId(deviceId)
    
    try {
      // Directly call the bootloader update command with the latest version reported by backend
      console.log('Calling update_device_bootloader with deviceId:', deviceId)

      // Prefer the backend-provided latest version; fallback to known good "2.1.4"
      const latestVersion = (deviceStatus as any)?.bootloaderCheck?.latestVersion || '2.1.4'

      // Call the backend command to update the bootloader
      // This will internally create a high-priority blocking action
      const result = await invoke('update_device_bootloader', { 
        deviceId, 
        targetVersion: latestVersion 
      }) as boolean
      
      console.log('Bootloader update result:', result)
      
      if (result) {
        // Show success message and close settings dialog
        alert('Bootloader update initiated. Please follow the instructions on your device.')
        // Close the settings dialog
        onClose()
      } else {
        throw new Error("Bootloader update failed")
      }
    } catch (error) {
      console.error('Failed to start bootloader update:', error)
      
      // Show error message
      alert(`Failed to start bootloader update: ${error}`)
      
      // Fallback to direct dialog if command fails and close settings dialog
      setShowBootloaderUpdate(true)
      // Close the settings dialog to prevent multiple dialogs
      onClose()
    }
  }

  const handleFirmwareUpdate = async (deviceId: string) => {
    console.log('handleFirmwareUpdate called with deviceId:', deviceId)
    setSelectedDeviceId(deviceId)
    
    try {
      // Get device info to find current firmware version
      const deviceInfo = await invoke('get_device_info_by_id', { deviceId }) as any
      console.log('Device info for firmware update:', deviceInfo)
      
      const currentVersion = deviceInfo?.version || deviceInfo?.features?.version || "2.1.4"
      const targetVersion = "7.10.0" // From releases.json
      
      console.log(`Opening firmware update wizard: ${currentVersion} -> ${targetVersion}`)
      
      // Close settings dialog first
      onClose()
      
      // Show the firmware update wizard directly
      firmwareWizard.show({
        deviceId,
        currentVersion,
        targetVersion,
        onWizardClose: () => {
          console.log('Firmware update wizard closed')
        },
        onComplete: (success: boolean, updatedDeviceId: string) => {
          console.log('Firmware update completed:', success, updatedDeviceId)
        }
      })
    } catch (error) {
      console.error('Failed to open firmware update wizard:', error)
      alert(`Failed to open firmware update wizard: ${error}`)
    }
  }

  const handleCreateWallet = async (deviceId: string) => {
    console.log('🚀 [SettingsDialog] handleCreateWallet called with deviceId:', deviceId)
    setSelectedDeviceId(deviceId)
    
    try {
      console.log('🚀 [SettingsDialog] Opening wallet creation wizard for device:', deviceId)
      console.log('🚀 [SettingsDialog] Current walletCreationWizard:', walletCreationWizard)
      
      // Close settings dialog first
      console.log('🚀 [SettingsDialog] Closing settings dialog...')
      onClose()
      
      // Add a small delay to ensure settings dialog closes first
      setTimeout(() => {
        console.log('🚀 [SettingsDialog] Calling walletCreationWizard.show()...')
        
        // Show the wallet creation wizard using DialogContext
        walletCreationWizard.show({
          deviceId,
          onWizardClose: () => {
            console.log('🚀 [SettingsDialog] Wallet creation wizard closed')
          },
          onWizardComplete: () => {
            console.log('🚀 [SettingsDialog] Wallet creation wizard completed for device:', deviceId)
          }
        })
        
        console.log('🚀 [SettingsDialog] walletCreationWizard.show() called successfully')
      }, 100)
      
    } catch (error) {
      console.error('🚀 [SettingsDialog] Failed to open wallet creation wizard:', error)
      alert(`Failed to open wallet creation wizard: ${error}`)
    }
  }

  const handleVerifySeed = (deviceId: string, deviceLabel?: string) => {
    console.log('🔍 [SettingsDialog] handleVerifySeed called with deviceId:', deviceId)
    
    // Store device info for verification wizard
    setVerificationDeviceId(deviceId)
    setVerificationDeviceLabel(deviceLabel || null)
    
    // Close settings dialog first
    console.log('🔍 [SettingsDialog] Closing settings dialog...')
    onClose()
    
    // Add a small delay to ensure settings dialog closes first
    setTimeout(() => {
      console.log('🔍 [SettingsDialog] Opening verification wizard...')
      setVerificationWizardOpen(true)
    }, 100)
  }

  const handleVerificationClose = () => {
    console.log('🔍 [SettingsDialog] Seed verification wizard closed')
    setVerificationWizardOpen(false)
    setVerificationDeviceId(null)
    setVerificationDeviceLabel(null)
  }

  const handleOpenPairings = async () => {
    try {
      // First close the settings dialog
      onClose()
      
      // Then notify backend to open pairings view
      await invoke('vault_change_view', { view: 'pairings' })
    } catch (error) {
      console.error('Failed to open pairings view:', error)
      // Fallback - could emit an event or handle differently
    }
  }

  // Log viewer functions
  const loadLogs = async () => {
    setIsLoadingLogs(true)
    try {
      const recentLogs = await invoke<LogEntry[]>('get_recent_device_logs', { limit: logLimit })
      setLogs(recentLogs)
      
      // Also get the log file path
      const path = await invoke<string>('get_device_log_path')
      setLogPath(path)
      
      // Update last refresh time
      setLastRefresh(new Date())
    } catch (error) {
      console.error('Failed to load logs:', error)
      setLogs([])
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const handleDownloadLogs = async () => {
    setIsDownloading(true)
    try {
      // First ensure logs exist by trying to load them
      if (logs.length === 0) {
        await loadLogs()
      }
      
      // Get the log file path
      const path = await invoke<string>('get_device_log_path')
      
      if (!path) {
        showToast('No log file path available', 'error')
        return
      }
      
      // Copy the path to clipboard
      await navigator.clipboard.writeText(path)
      
      // Extract filename and directory for display
      const parts = path.split('/')
      const fileName = parts.pop() || 'device-communications.log'
      const directory = parts.join('/')
      
      // Update the displayed log path
      setLogPath(path)
      
      // Show success toast with more helpful message
      showToast(`Log path copied to clipboard!\nPath: ${path}`, 'success')
      
      // Also show console log for debugging
      console.log('Log file path:', path)
      console.log('Log directory:', directory)
      console.log('Log filename:', fileName)
      
      // Try to open the folder in file explorer using tauri-plugin-opener
      try {
        // For file paths, we need to add file:// prefix
        const fileUrl = directory.startsWith('/') ? `file://${directory}` : directory
        await invoke('open_url', { url: fileUrl })
      } catch (err) {
        console.log('Could not open folder automatically. Path is copied to clipboard:', err)
        // Show additional help in the toast
        showToast(`Path copied! Open Finder and press Cmd+Shift+G to go to:\n${directory}`, 'info')
      }
    } catch (error: any) {
      console.error('Failed to handle log download:', error)
      
      // More specific error messages
      if (error.toString().includes('not found')) {
        showToast('No logs found. Try connecting a device first.', 'error')
      } else if (error.toString().includes('permission')) {
        showToast('Permission denied accessing log files', 'error')
      } else {
        showToast(`Failed to access log file: ${error.toString()}`, 'error')
      }
    } finally {
      setIsDownloading(false)
    }
  }

  const handleCleanupLogs = async () => {
    try {
      await invoke('cleanup_device_logs')
      showToast('Old logs cleaned up successfully', 'success')
      // Reload logs after cleanup
      await loadLogs()
    } catch (error) {
      console.error('Failed to cleanup logs:', error)
      showToast('Failed to cleanup old logs', 'error')
    }
  }

  const filteredLogs = logs.filter(log => {
    // Apply filter
    if (logFilter === 'requests' && log.direction !== 'REQUEST' && log.direction !== 'SEND') return false
    if (logFilter === 'responses' && log.direction !== 'RESPONSE' && log.direction !== 'RECEIVE') return false
    if (logFilter === 'errors' && log.success !== false && !log.error) return false
    
    // Apply search to the formatted terminal output
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase()
      const formattedOutput = formatLogEntry(log).toLowerCase()
      const deviceId = (log.device_id || '').toLowerCase()
      const requestType = (log.request_type || log.message_type || '').toLowerCase()
      
      return formattedOutput.includes(searchLower) || 
             deviceId.includes(searchLower) || 
             requestType.includes(searchLower)
    }
    
    return true
  })

  const formatLogEntry = (log: LogEntry) => {
    // Format logs to look like terminal output
    if (log.direction === 'REQUEST' || log.direction === 'SEND') {
      // Outgoing requests
      const requestType = log.request_type || log.message_type || t('settings:logs.unknown')
      return `-> ${requestType}`
    } else if (log.direction === 'RESPONSE' || log.direction === 'RECEIVE') {
      // Incoming responses
      const requestType = log.request_type || log.message_type || t('settings:logs.unknown')
      const success = log.success !== false ? '✅' : '❌'
      
      // Try to extract meaningful info from the response
      let responseInfo = ''
      if (log.data) {
        // Handle GetFeatures responses
        if (log.data.features && log.data.features.label) {
          responseInfo = `${log.data.features.label} v${log.data.features.version || t('settings:logs.unknown')}`
        } else if (log.data.status && log.data.status.features && log.data.status.features.label) {
          responseInfo = `${log.data.status.features.label} v${log.data.status.features.version || t('settings:logs.unknown')}`
        } else if (log.data.response && typeof log.data.response === 'string') {
          // For xpub responses, show truncated version
          if (log.data.response.startsWith('xpub') || log.data.response.startsWith('ypub') || log.data.response.startsWith('zpub')) {
            responseInfo = `${log.data.response.substring(0, 16)}...`
          } else {
            responseInfo = log.data.response
          }
        } else if (requestType === 'GetFeatures' && log.data.operation) {
          responseInfo = 'Features received'
        } else {
          responseInfo = requestType.replace('Get', '').replace('Request', '')
        }
      }
      
      return `<- ${responseInfo} ${success}`
    } else {
      // Other log types (like status messages)
      const deviceShort = log.device_id ? log.device_id.substring(log.device_id.length - 8) : 'system'
      
      // Handle different operation types
      if (log.data && log.data.operation) {
        const operation = log.data.operation
        if (operation === 'get_device_status') {
          return `Getting device status for: ${log.device_id}`
        } else if (operation === 'get_features_for_device') {
          return `📡 Fetching device features for: ${deviceShort}`
        } else if (log.data.status) {
          const status = log.data.status
          if (status.bootloaderCheck) {
            return `🔧 Bootloader check: ${status.bootloaderCheck.currentVersion} -> needs update: ${status.bootloaderCheck.needsUpdate} (bootloader_mode: ${status.features?.bootloader_mode || false})`
          } else if (status.firmwareCheck) {
            return `🔧 Firmware check: ${status.firmwareCheck.currentVersion} vs ${status.firmwareCheck.latestVersion} -> needs update: ${status.firmwareCheck.needsUpdate} (bootloader_mode: ${status.features?.bootloader_mode || false})`
          } else if (status.initializationCheck) {
            return `🔧 Initialization check: initialized=${status.initializationCheck.initialized}, needs_setup=${status.initializationCheck.needsSetup}, has_pin_protection=${status.features?.pin_protection || false}, pin_cached=${status.features?.pin_cached || false}`
          }
        }
        return `${operation.replace(/_/g, ' ')}: ${deviceShort}`
      }
      
      return `${log.direction}: ${log.data ? JSON.stringify(log.data).substring(0, 100) : 'No data'}...`
    }
  }

  // Load logs when the dialog opens
  useEffect(() => {
    if (isOpen) {
      loadLogs()
    }
  }, [isOpen, logLimit])
  
  // Load API status when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadApiStatus()
    }
  }, [isOpen])

  // Auto-refresh functionality
  useEffect(() => {
    if (autoRefresh && isOpen) {
      const interval = setInterval(() => {
        loadLogs()
      }, 2000) // Refresh every 2 seconds
      setRefreshInterval(interval)
      
      return () => {
        clearInterval(interval)
      }
    } else {
      if (refreshInterval) {
        clearInterval(refreshInterval)
        setRefreshInterval(null)
      }
    }
  }, [autoRefresh, isOpen, logLimit])

  // Auto-scroll to bottom when new logs arrive (if auto-refresh is on)
  useEffect(() => {
    if (autoRefresh && logs.length > 0) {
      const logContainer = document.getElementById('log-container')
      if (logContainer) {
        logContainer.scrollTop = logContainer.scrollHeight
      }
    }
  }, [logs, autoRefresh])
  
  // Save settings functions
  const handleCurrencyChange = (newCurrency: string) => {
    setCurrency(newCurrency)
    showToast(t('settings:messages.saved'), 'success')
  }

  const handleNumberFormatChange = (newFormat: string) => {
    setNumberFormat(newFormat)
    showToast(t('settings:messages.saved'), 'success')
  }

  // Show toast notification
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type, visible: true })
    setTimeout(() => setToast(prev => ({ ...prev, visible: false })), 4000)
  }
  
  return (
    <>
      <DialogRoot open={isOpen} onOpenChange={({ open }) => !open && onClose()}>
        <DialogContent 
          width="600px"
          height="700px"
          bg="gray.900" 
          color="white"
          border="2px solid"
          borderColor="gray.600"
          boxShadow="0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 8px 16px -8px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)"
          borderRadius="xl"
          position="relative"
          _before={{
            content: '""',
            position: "absolute",
            top: "-1px",
            left: "-1px",
            right: "-1px",
            bottom: "-1px",
            background: "linear-gradient(135deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.1))",
            borderRadius: "xl",
            zIndex: -1,
          }}
        >
          <DialogHeader borderBottomWidth="1px" borderColor="gray.700" pb={4}>
            <DialogTitle color="white">{t('settings:title')}</DialogTitle>
            <DialogCloseTrigger color="gray.400" _hover={{ color: "white" }}>
              <FaTimes />
            </DialogCloseTrigger>
          </DialogHeader>
          
          <DialogBody p={6} flex="1" overflowY="auto">
            <Tabs.Root defaultValue="general">
              <Tabs.List bg="gray.800" borderRadius="md" p={1} mb={6}>
                <Tabs.Trigger 
                  value="general"
                  flex="1"
                  gap={2}
                  color="gray.400"
                  _selected={{ bg: "gray.700", color: "white" }}
                  _hover={{ color: "white" }}
                >
                  <LuSettings size={16} />
                  {t('settings:tabs.general')}
                </Tabs.Trigger>
                {/*<Tabs.Trigger */}
                {/*  value="app"*/}
                {/*  flex="1"*/}
                {/*  gap={2}*/}
                {/*  color="gray.400"*/}
                {/*  _selected={{ bg: "gray.700", color: "white" }}*/}
                {/*  _hover={{ color: "white" }}*/}
                {/*>*/}
                {/*  <LuMonitor size={16} />*/}
                {/*  App*/}
                {/*</Tabs.Trigger>*/}
                <Tabs.Trigger 
                  value="bitcoin"
                  flex="1"
                  gap={2}
                  color="gray.400"
                  _selected={{ bg: "gray.700", color: "white" }}
                  _hover={{ color: "white" }}
                >
                  Bitcoin
                </Tabs.Trigger>
                <Tabs.Trigger 
                  value="keepkey"
                  flex="1"
                  gap={2}
                  color="gray.400"
                  _selected={{ bg: "gray.700", color: "white" }}
                  _hover={{ color: "white" }}
                >
                KeepKey
                </Tabs.Trigger>
                <Tabs.Trigger 
                  value="logs"
                  flex="1"
                  gap={2}
                  color="gray.400"
                  _selected={{ bg: "gray.700", color: "white" }}
                  _hover={{ color: "white" }}
                >
                  <LuFileText size={16} />
                  Logs
                </Tabs.Trigger>
                <Tabs.Trigger 
                  value="mcp"
                  flex="1"
                  gap={2}
                  color="gray.400"
                  _selected={{ bg: "gray.700", color: "white" }}
                  _hover={{ color: "white" }}
                >
                  <FaGlobe size={16} />
                  MCP
                </Tabs.Trigger>
              </Tabs.List>

              <Tabs.Content value="general" minHeight="400px" overflowY="auto">
                <VStack align="stretch" gap={4}>
                  <Text color="white" fontSize="lg" fontWeight="semibold">{t('settings:general.title')}</Text>
                  
                  {/* Language Settings */}
                  <Box bg="gray.800" p={4} borderRadius="md" border="1px solid" borderColor="gray.700">
                    <VStack align="stretch" gap={3}>
                      <HStack gap={2}>
                        <FaGlobe color="green.400" />
                        <Text color="white" fontWeight="medium">{t('settings:general.language.label')}</Text>
                      </HStack>
                      <HStack justify="space-between" align="center">
                        <Text color="gray.300" fontSize="sm">{t('settings:general.language.label')}</Text>
                        <LanguageSwitcher />
                      </HStack>
                      <Text color="gray.400" fontSize="xs">
                        {t('settings:general.language.description')}
                      </Text>
                    </VStack>
                  </Box>

                  {/* Currency Settings */}
                  <Box bg="gray.800" p={4} borderRadius="md" border="1px solid" borderColor="gray.700">
                    <VStack align="stretch" gap={3}>
                      <HStack gap={2}>
                        <FaDollarSign color="green.400" />
                        <Text color="white" fontWeight="medium">{t('settings:general.currency.label')}</Text>
                      </HStack>
                      <HStack justify="space-between" align="center">
                        <Text color="gray.300" fontSize="sm">{t('settings:general.currency.label')}</Text>
                        <select
                          value={currency}
                          onChange={(e) => handleCurrencyChange(e.target.value)}
                          style={{
                            backgroundColor: '#2D3748',
                            color: 'white',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            border: '1px solid #4A5568',
                            fontSize: '14px',
                            cursor: 'pointer'
                          }}
                        >
                          <option value="USD">{t('settings:general.currency.usd')}</option>
                          <option value="EUR">{t('settings:general.currency.eur')}</option>
                          <option value="GBP">{t('settings:general.currency.gbp')}</option>
                          <option value="JPY">{t('settings:general.currency.jpy')}</option>
                          <option value="CNY">{t('settings:general.currency.cny')}</option>
                        </select>
                      </HStack>
                      <HStack justify="space-between" align="center">
                        <Text color="gray.300" fontSize="sm">Number Format</Text>
                        <select
                          value={numberFormat}
                          onChange={(e) => handleNumberFormatChange(e.target.value)}
                          style={{
                            backgroundColor: '#2D3748',
                            color: 'white',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            border: '1px solid #4A5568',
                            fontSize: '14px',
                            cursor: 'pointer'
                          }}
                        >
                          <option value="1,000.00">1,000.00 (US)</option>
                          <option value="1.000,00">1.000,00 (EU)</option>
                          <option value="1 000,00">1 000,00 (FR)</option>
                          <option value="1,000">1,000 (No decimals)</option>
                        </select>
                      </HStack>
                      <Text color="gray.400" fontSize="xs">
                        {t('settings:general.currency.description')}
                      </Text>
                    </VStack>
                  </Box>
                </VStack>
              </Tabs.Content>

              <Tabs.Content value="app" minHeight="400px" overflowY="auto">
                <VStack align="stretch" gap={4}>
                  <Text color="white" fontSize="lg" fontWeight="semibold">Application Settings</Text>
                  
                  {/* Pairings Section */}
                  <Box bg="gray.800" p={4} borderRadius="md" border="1px solid" borderColor="gray.700">
                    <VStack align="stretch" gap={3}>
                      <HStack justify="space-between" align="center">
                        <VStack align="start" gap={1}>
                          <Text color="white" fontWeight="medium">Device Pairings</Text>
                          <Text color="gray.400" fontSize="sm">
                            Manage connected applications and services
                          </Text>
                        </VStack>
                        <Button
                          colorScheme="blue"
                          size="sm"
                          onClick={handleOpenPairings}
                        >
                          <HStack gap={2}>
                            <FaLink />
                            <Text>Open Pairings</Text>
                          </HStack>
                        </Button>
                      </HStack>
                    </VStack>
                  </Box>

                  {/* Future app settings can go here */}
                  <Text color="gray.400" fontSize="sm">More app settings coming soon...</Text>
                </VStack>
              </Tabs.Content>

              <Tabs.Content value="bitcoin" minHeight="400px" overflowY="auto">
                <BitcoinSettings />
              </Tabs.Content>

              <Tabs.Content value="keepkey" minHeight="400px" overflowY="auto">
                <VStack align="stretch" gap={4}>
                  <KeepKeyDeviceList 
                    onBootloaderUpdate={handleBootloaderUpdate}
                    onFirmwareUpdate={handleFirmwareUpdate}
                    onCreateWallet={handleCreateWallet}
                    onVerifySeed={handleVerifySeed}
                  />
                </VStack>
              </Tabs.Content>

              <Tabs.Content value="logs" minHeight="400px">
                <VStack align="stretch" gap={4}>
                  {/* Title centered */}
                  <Text color="white" fontSize="lg" fontWeight="semibold" textAlign="center">
                    Device Communication Logs
                  </Text>
                  
                  {/* Buttons centered on separate line */}
                  <HStack gap={2} justify="center">
                    <Button
                      size="sm"
                      colorScheme={autoRefresh ? "orange" : "blue"}
                      onClick={() => setAutoRefresh(!autoRefresh)}
                    >
                      <HStack gap={1}>
                        <FaSyncAlt />
                        <Text>{autoRefresh ? t('settings:logs.stopAuto') : t('settings:logs.autoRefresh')}</Text>
                      </HStack>
                    </Button>
                    <Button
                      size="sm"
                      colorScheme="blue"
                      onClick={loadLogs}
                      loading={isLoadingLogs}
                      disabled={autoRefresh}
                    >
                      <HStack gap={1}>
                        <FaSyncAlt />
                        <Text>{isLoadingLogs ? t('settings:logs.loading') : t('settings:logs.refresh')}</Text>
                      </HStack>
                    </Button>
                    <Button
                      size="sm"
                      colorScheme="green"
                      onClick={handleDownloadLogs}
                      loading={isDownloading}
                      disabled={isDownloading}
                    >
                      <HStack gap={1}>
                        {isDownloading ? (
                          <Spinner size="xs" />
                        ) : (
                          <FaDownload />
                        )}
                        <Text>{isDownloading ? t('settings:logs.copying') : t('settings:logs.saveLogs')}</Text>
                      </HStack>
                    </Button>
                    <Button
                      size="sm"
                      colorScheme="red"
                      onClick={handleCleanupLogs}
                    >
                      <HStack gap={1}>
                        <FaTrash />
                        <Text>Cleanup</Text>
                      </HStack>
                    </Button>
                  </HStack>

                  {/* Log Controls */}
                  <Box bg="gray.800" p={4} borderRadius="md" border="1px solid" borderColor="gray.700">
                    <VStack align="stretch" gap={3}>
                      <HStack gap={4} wrap="wrap">
                        <HStack flex="1" minW="200px">
                          <FaSearch color="gray.400" />
                          <Input
                            placeholder="Search logs..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            bg="gray.900"
                            border="1px solid"
                            borderColor="gray.600"
                            color="white"
                            _placeholder={{ color: "gray.400" }}
                            size="sm"
                          />
                        </HStack>
                        <HStack>
                          <FaFilter color="gray.400" />
                          <select
                            value={logFilter}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLogFilter(e.target.value)}
                            style={{
                              backgroundColor: 'var(--chakra-colors-gray-900)',
                              border: '1px solid var(--chakra-colors-gray-600)',
                              color: 'white',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              minWidth: '120px'
                            }}
                          >
                            <option value="all">All</option>
                            <option value="requests">Requests</option>
                            <option value="responses">Responses</option>
                            <option value="errors">Errors</option>
                          </select>
                        </HStack>
                        <HStack>
                          <Text color="gray.400" fontSize="sm">Limit:</Text>
                          <select
                            value={logLimit.toString()}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLogLimit(parseInt(e.target.value))}
                            style={{
                              backgroundColor: 'var(--chakra-colors-gray-900)',
                              border: '1px solid var(--chakra-colors-gray-600)',
                              color: 'white',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              minWidth: '80px'
                            }}
                          >
                            <option value="25">25</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                            <option value="200">200</option>
                          </select>
                        </HStack>
                      </HStack>
                      
                      {logPath && (
                        <HStack gap={2}>
                          <Text color="gray.400" fontSize="xs">Log file:</Text>
                          <Text color="blue.300" fontSize="xs" fontFamily="mono" wordBreak="break-all">
                            {logPath}
                          </Text>
                        </HStack>
                      )}
                    </VStack>
                  </Box>

                                    {/* Terminal-style Log Display */}
                  <Box 
                    id="log-container"
                    bg="black" 
                    borderRadius="md" 
                    border="1px solid" 
                    borderColor="gray.600" 
                    maxH="400px" 
                    overflowY="auto"
                    p={4}
                    position="relative"
                  >
                    {autoRefresh && (
                      <Box
                        position="absolute"
                        top={2}
                        right={2}
                        bg="orange.600"
                        color="white"
                        px={2}
                        py={1}
                        fontSize="xs"
                        borderRadius="sm"
                        fontWeight="bold"
                        zIndex={1}
                      >
                        LIVE
                      </Box>
                    )}
                    {isLoadingLogs ? (
                      <Flex justify="center" align="center" p={8}>
                        <VStack gap={2}>
                          <Spinner color="green.400" />
                          <Text color="green.400" fontFamily="mono">Loading logs...</Text>
                        </VStack>
                      </Flex>
                    ) : filteredLogs.length === 0 ? (
                      <Flex justify="center" align="center" p={8}>
                        <Text color="green.400" fontFamily="mono">No logs found matching current filters</Text>
                      </Flex>
                    ) : (
                      <VStack align="stretch" gap={1}>
                        {filteredLogs.map((log, index) => {
                          const formatted = formatLogEntry(log)
                          // Show only time (HH:MM:SS) without date
                          const timestamp = new Date(log.timestamp).toLocaleTimeString('en-US', { 
                            hour12: false,
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                          })
                          
                          // Color coding based on log type
                          let color = "green.300"
                          if (formatted.startsWith('->')) {
                            color = "blue.300" // Outgoing requests
                          } else if (formatted.startsWith('<-')) {
                            color = formatted.includes('❌') ? "red.300" : "green.300" // Responses
                          } else if (formatted.includes('🔧')) {
                            color = "yellow.300" // System checks
                          } else if (formatted.includes('📡')) {
                            color = "cyan.300" // Network/communication
                          }
                          
                          return (
                            <HStack key={index} gap={2} align="start" fontSize="sm" fontFamily="mono">
                              <Text color="gray.500" fontSize="xs" minW="70px" flexShrink={0}>
                                {timestamp}
                              </Text>
                              <Text color={color} wordBreak="break-word" flex={1}>
                                {formatted}
                              </Text>
                            </HStack>
                          )
                        })}
                      </VStack>
                    )}
                  </Box>

                  {/* Log Stats */}
                  <HStack justify="space-between" align="center" color="gray.400" fontSize="sm" wrap="wrap">
                    <Text>Showing {filteredLogs.length} of {logs.length} log entries</Text>
                    <HStack gap={4}>
                      {lastRefresh && (
                        <Text>Last updated: {lastRefresh.toLocaleTimeString()}</Text>
                      )}
                      {autoRefresh && (
                        <Text color="orange.400" fontWeight="bold">Auto-refreshing every 2s</Text>
                      )}
                    </HStack>
                  </HStack>
                </VStack>
              </Tabs.Content>

              <Tabs.Content value="mcp" minHeight="400px" overflowY="auto">
                <VStack align="stretch" gap={4}>
                  <Text color="white" fontSize="lg" fontWeight="semibold">MCP & API Access</Text>
                  
                  {/* API Enable/Disable Section */}
                  <Box bg="gray.800" p={4} borderRadius="md" border="1px solid" borderColor="gray.700">
                    <VStack align="stretch" gap={3}>
                      <VStack align="start" gap={1}>
                        <Text color="white" fontWeight="medium" fontSize="lg">{t('settings:api.enableTitle')}</Text>
                        <Text color="gray.400" fontSize="sm">
                          {t('settings:api.enableDescription')}
                        </Text>
                      </VStack>
                      <HStack justify="space-between" align="center">
                        <HStack gap={2}>
                          <Box w={2} h={2} bg={apiStatus?.running ? "green.400" : "gray.500"} borderRadius="full" />
                          <Text 
                            color={apiStatus?.running ? "green.400" : "gray.500"} 
                            fontSize="sm" 
                            fontWeight="medium"
                          >
                            {apiStatus?.running ? t('settings:api.running') : t('settings:api.stopped')}
                          </Text>
                        </HStack>
                        <Button
                          size="sm"
                          colorScheme={apiEnabled ? "red" : "green"}
                          onClick={() => handleToggleApi(!apiEnabled)}
                          loading={isTogglingApi}
                          disabled={isTogglingApi}
                          minW="80px"
                        >
                          {apiEnabled ? t('settings:api.disable') : t('settings:api.enable')}
                        </Button>
                      </HStack>
                    </VStack>
                  </Box>
                  
                  {/* API URLs Section */}
                  <Box 
                    bg="gray.800" 
                    p={4} 
                    borderRadius="md" 
                    border="1px solid" 
                    borderColor="gray.700"
                    opacity={apiEnabled ? 1 : 0.5}
                    position="relative"
                  >
                    {!apiEnabled && (
                      <HStack 
                        position="absolute"
                        top={4}
                        right={4}
                        gap={1}
                      >
                        <FaLock size={12} color="gray.500" />
                        <Text color="gray.500" fontSize="xs" fontWeight="medium">Locked</Text>
                      </HStack>
                    )}
                    <VStack align="stretch" gap={4}>
                      <Text color="white" fontWeight="medium">API Endpoints</Text>
                      
                      {/* REST API */}
                      <Box bg="gray.900" p={3} borderRadius="md">
                        <VStack align="stretch" gap={2}>
                          <Text color="gray.300" fontSize="sm" fontWeight="medium">REST API Documentation</Text>
                          <HStack justify="space-between" align="center">
                            <Link 
                              href="http://127.0.0.1:1646/docs" 
                              target="_blank" 
                              fontSize="sm" 
                              color="blue.300"
                              _hover={{ color: "blue.200", textDecoration: "underline" }}
                              flex="1"
                              opacity={apiEnabled ? 1 : 0.5}
                              pointerEvents={apiEnabled ? "auto" : "none"}
                            >
                              http://127.0.0.1:1646/docs
                            </Link>
                            <Button
                              size="xs"
                              variant="ghost"
                              colorScheme={hasCopiedRest ? "green" : "blue"}
                              aria-label="Copy REST URL to clipboard"
                              onClick={handleCopyRest}
                              minW="60px"
                              disabled={!apiEnabled}
                            >
                              {hasCopiedRest ? (
                                <HStack gap={1}>
                                  <FaCheck size="10px" />
                                  <Text fontSize="xs">Copied</Text>
                                </HStack>
                              ) : (
                                <HStack gap={1}>
                                  <FaCopy size="10px" />
                                  <Text fontSize="xs">Copy</Text>
                                </HStack>
                              )}
                            </Button>
                          </HStack>
                          <Text color="gray.500" fontSize="xs">
                            Interactive API documentation and testing interface
                          </Text>
                        </VStack>
                      </Box>

                      {/* MCP Endpoint */}
                      <Box bg="gray.900" p={3} borderRadius="md">
                        <VStack align="stretch" gap={2}>
                          <Text color="gray.300" fontSize="sm" fontWeight="medium">MCP (Model Context Protocol)</Text>
                          <HStack justify="space-between" align="center">
                            <Link 
                              href="http://127.0.0.1:1646/mcp" 
                              target="_blank" 
                              fontSize="sm" 
                              color="blue.300"
                              _hover={{ color: "blue.200", textDecoration: "underline" }}
                              flex="1"
                              opacity={apiEnabled ? 1 : 0.5}
                              pointerEvents={apiEnabled ? "auto" : "none"}
                            >
                              http://127.0.0.1:1646/mcp
                            </Link>
                            <Button
                              size="xs"
                              variant="ghost"
                              colorScheme={hasCopiedMcp ? "green" : "blue"}
                              aria-label="Copy MCP URL to clipboard"
                              onClick={handleCopyMcp}
                              minW="60px"
                              disabled={!apiEnabled}
                            >
                              {hasCopiedMcp ? (
                                <HStack gap={1}>
                                  <FaCheck size="10px" />
                                  <Text fontSize="xs">Copied</Text>
                                </HStack>
                              ) : (
                                <HStack gap={1}>
                                  <FaCopy size="10px" />
                                  <Text fontSize="xs">Copy</Text>
                                </HStack>
                              )}
                            </Button>
                          </HStack>
                          <Text color="gray.500" fontSize="xs">
                            AI assistant integration endpoint for Claude and other LLMs
                          </Text>
                        </VStack>
                      </Box>
                    </VStack>
                  </Box>

                  {/* Status Section */}
                  <Box 
                    bg="gray.800" 
                    p={4} 
                    borderRadius="md" 
                    border="1px solid" 
                    borderColor="gray.700"
                    opacity={apiEnabled ? 1 : 0.5}
                  >
                    <VStack align="stretch" gap={3}>
                      <Text color="white" fontWeight="medium">{t('settings:api.serviceStatus')}</Text>
                      <HStack justify="space-between" align="center">
                        <Text color="gray.300" fontSize="sm">API Server</Text>
                        <HStack gap={2}>
                          <Box w={2} h={2} bg={apiStatus?.running ? "green.400" : "gray.500"} borderRadius="full" />
                          <Text 
                            color={apiStatus?.running ? "green.400" : "gray.500"} 
                            fontSize="sm" 
                            fontWeight="medium"
                          >
                            {apiStatus?.running ? t('settings:api.running') : t('settings:api.stopped')}
                          </Text>
                        </HStack>
                      </HStack>
                      <HStack justify="space-between" align="center">
                        <Text color="gray.300" fontSize="sm">API Port</Text>
                        <Text color="gray.300" fontSize="sm" fontFamily="mono">
                          {apiStatus?.port || 1646}
                        </Text>
                      </HStack>
                    </VStack>
                  </Box>

                  {/* Information Section */}
                  <Box bg="gray.800" p={4} borderRadius="md" border="1px solid" borderColor="gray.700">
                    <VStack align="stretch" gap={2}>
                      <Text color="gray.300" fontSize="sm" fontWeight="medium">About MCP & REST API</Text>
                      <Text color="gray.400" fontSize="xs">
                        When enabled, the REST API provides programmatic access to your KeepKey device, while the Model Context Protocol (MCP) 
                        allows AI assistants to help you manage your Bitcoin. The server runs locally on port 1646 and requires a restart after changing settings.
                      </Text>
                    </VStack>
                  </Box>
                </VStack>
              </Tabs.Content>
            </Tabs.Root>
          </DialogBody>
        </DialogContent>
        
        {/* Toast Notification */}
        {toast.visible && (
          <Box
            position="fixed"
            bottom={4}
            right={4}
            bg={
              toast.type === 'success' ? 'green.600' :
              toast.type === 'error' ? 'red.600' : 'blue.600'
            }
            color="white"
            px={4}
            py={3}
            borderRadius="md"
            boxShadow="lg"
            zIndex={9999}
            maxW="400px"
            css={{
              animation: 'slideIn 0.3s ease-out',
              '@keyframes slideIn': {
                '0%': {
                  transform: 'translateX(100%)',
                  opacity: 0
                },
                '100%': {
                  transform: 'translateX(0)',
                  opacity: 1
                }
              }
            }}
          >
            <HStack gap={2}>
              {toast.type === 'success' && <FaCheck />}
              {toast.type === 'error' && <FaTimes />}
              {toast.type === 'info' && <FaFolder />}
              <Text fontSize="sm">{toast.message}</Text>
            </HStack>
          </Box>
        )}
      </DialogRoot>

      {/* Update Dialogs - Only shown when settings dialog is closed */}
      {showBootloaderUpdate && !isOpen && (
        deviceStatus?.bootloaderCheck ? (
          <BootloaderUpdateDialog
            isOpen={showBootloaderUpdate}
            bootloaderCheck={deviceStatus.bootloaderCheck}
            deviceId={selectedDeviceId || ''}
            onUpdateComplete={() => {
              console.log('Bootloader update completed for device:', selectedDeviceId)
              setShowBootloaderUpdate(false)
            }}
          />
        ) : (
          <DialogRoot open={showBootloaderUpdate} onOpenChange={() => setShowBootloaderUpdate(false)}>
            <DialogContent maxW="md" bg="gray.900" color="white" borderColor="orange.600" borderWidth="2px">
              <DialogHeader borderBottomWidth="1px" borderColor="gray.700" pb={4}>
                <DialogTitle color="white">Device Not In Updater Mode</DialogTitle>
                <DialogCloseTrigger color="gray.400" _hover={{ color: "white" }} />
              </DialogHeader>
              <DialogBody py={6}>
                <VStack align="stretch" gap={4}>
                  <Text fontWeight="bold">Your KeepKey needs to be in Bootloader Mode to update the bootloader.</Text>
                  
                  <Box display="flex" justifyContent="center" py={4}>
                    <img 
                      src={holdAndConnectSvg} 
                      alt="Hold button while connecting device" 
                      style={{ maxWidth: '240px', height: 'auto' }} 
                    />
                  </Box>
                  
                  <VStack align="stretch" gap={2} bg="gray.800" p={4} borderRadius="md">
                    <Text fontWeight="semibold">How to enter Bootloader Mode:</Text>
                    <Text fontSize="sm">1. Unplug your KeepKey</Text>
                    <Text fontSize="sm">2. Hold down the button on your device</Text>
                    <Text fontSize="sm">3. While holding the button, plug in your KeepKey</Text>
                    <Text fontSize="sm">4. Continue holding until you see "BOOTLOADER MODE" on the screen</Text>
                    <Text fontSize="sm">5. Release the button and try the update again</Text>
                  </VStack>
                  
                  <Text fontSize="sm" color="gray.400">Device ID: {selectedDeviceId || t('settings:logs.unknown')}</Text>
                </VStack>
              </DialogBody>
              <Box borderTopWidth="1px" borderColor="gray.700" pt={4} mt={4}>
                <Button colorScheme="orange" onClick={() => setShowBootloaderUpdate(false)} width="full">
                  I'll Try Again Later
                </Button>
              </Box>
            </DialogContent>
          </DialogRoot>
        )
      )}

      {showFirmwareUpdate && !isOpen && deviceStatus?.firmwareCheck && (
        <FirmwareUpdateDialog
          isOpen={showFirmwareUpdate}
          firmwareCheck={deviceStatus.firmwareCheck}
          onUpdateStart={() => {
            console.log('Starting firmware update for device:', selectedDeviceId)
            setShowFirmwareUpdate(false)
          }}
          onSkip={() => setShowFirmwareUpdate(false)}
          onRemindLater={() => setShowFirmwareUpdate(false)}
          onClose={() => setShowFirmwareUpdate(false)}
        />
      )}

      {verificationWizardOpen && !isOpen && (
        <SeedVerificationWizard
          isOpen={verificationWizardOpen}
          deviceId={verificationDeviceId || ''}
          deviceLabel={verificationDeviceLabel || ''}
          onClose={handleVerificationClose}
        />
      )}

    </>
  )
}

export const SettingsButton = ({ onClick }: { onClick: () => void }) => {
  return (
    <Button
      position="absolute"
      bottom="20px"
      left="20px"
      size="md"
      variant="ghost"
      colorScheme="blue"
      onClick={onClick}
      bg="rgba(0, 0, 0, 0.7)"
      _hover={{ bg: 'rgba(0, 0, 0, 0.8)' }}
    >
      <Icon as={FaCog} boxSize={5} />
    </Button>
  )
} 