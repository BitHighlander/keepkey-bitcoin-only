/**
 * Hook for tracking device ID mappings between placeholder and real IDs
 * This helps debug the device ID confusion issue
 */

import { useEffect, useRef } from 'react';
import { deviceLogger, LogCategory } from '../utils/deviceLogger';

interface DeviceIdMapping {
  placeholderId: string;
  realId: string | null;
  timestamp: number;
  source: string;
}

export function useDeviceIdMapping() {
  const mappings = useRef<Map<string, DeviceIdMapping>>(new Map());
  
  const addMapping = (placeholderId: string, realId: string | null, source: string) => {
    const mapping: DeviceIdMapping = {
      placeholderId,
      realId,
      timestamp: Date.now(),
      source
    };
    
    mappings.current.set(placeholderId, mapping);
    
    deviceLogger.info(LogCategory.DEVICE_ID, 'Device ID mapping added', {
      placeholderId,
      realId,
      source,
      totalMappings: mappings.current.size,
      allMappings: Array.from(mappings.current.entries())
    });
  };
  
  const getMapping = (anyId: string): DeviceIdMapping | null => {
    // Check if it's a placeholder ID
    if (mappings.current.has(anyId)) {
      return mappings.current.get(anyId)!;
    }
    
    // Check if it's a real ID
    for (const [placeholderId, mapping] of mappings.current.entries()) {
      if (mapping.realId === anyId) {
        return mapping;
      }
    }
    
    return null;
  };
  
  const resolveId = (anyId: string): string => {
    const mapping = getMapping(anyId);
    
    if (mapping) {
      const resolvedId = mapping.realId || mapping.placeholderId;
      deviceLogger.debug(LogCategory.DEVICE_ID, 'Device ID resolved', {
        inputId: anyId,
        resolvedId,
        mapping
      });
      return resolvedId;
    }
    
    deviceLogger.debug(LogCategory.DEVICE_ID, 'Device ID not in mappings, returning as-is', {
      inputId: anyId,
      knownMappings: Array.from(mappings.current.keys())
    });
    return anyId;
  };
  
  const logMappingConflict = (description: string, details: any) => {
    deviceLogger.warn(LogCategory.STATE_CONFLICT, `Device ID mapping conflict: ${description}`, {
      ...details,
      currentMappings: Array.from(mappings.current.entries())
    });
  };
  
  // Log all mappings periodically for debugging
  useEffect(() => {
    const interval = setInterval(() => {
      if (mappings.current.size > 0) {
        deviceLogger.debug(LogCategory.DEVICE_ID, 'Current device ID mappings', {
          count: mappings.current.size,
          mappings: Array.from(mappings.current.entries()).map(([key, value]) => ({
            placeholder: key,
            real: value.realId,
            age: Date.now() - value.timestamp,
            source: value.source
          }))
        });
      }
    }, 30000); // Every 30 seconds
    
    return () => clearInterval(interval);
  }, []);
  
  return {
    addMapping,
    getMapping,
    resolveId,
    logMappingConflict
  };
}