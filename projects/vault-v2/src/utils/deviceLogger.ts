/**
 * Device Connection Logger
 * Comprehensive logging system for debugging device connection issues
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4
}

export enum LogCategory {
  // Device Operations
  DEVICE_CONNECTION = 'device.connection',
  DEVICE_COMMUNICATION = 'device.communication',
  DEVICE_UPDATE = 'device.update',
  DEVICE_AUTH = 'device.auth',
  DEVICE_ID = 'device.id',
  
  // UI Components
  UI_RENDER = 'ui.render',
  UI_ERROR = 'ui.error',
  UI_INTERACTION = 'ui.interaction',
  UI_NAVIGATION = 'ui.navigation',
  
  // State Management
  STATE_CHANGE = 'state.change',
  STATE_CONFLICT = 'state.conflict',
  
  // Events
  EVENT_RECEIVED = 'event.received',
  EVENT_EMITTED = 'event.emitted',
  
  // Errors
  ERROR_BOUNDARY = 'error.boundary',
  ERROR_RECOVERY = 'error.recovery'
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  correlationId?: string;
  deviceId?: string;
  placeholderId?: string;
  component?: string;
  data?: any;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

class DeviceLogger {
  private static instance: DeviceLogger;
  private logs: LogEntry[] = [];
  private currentLevel: LogLevel = LogLevel.DEBUG;
  private correlationId: string | null = null;
  private sessionId: string;
  
  private constructor() {
    this.sessionId = this.generateSessionId();
    this.setupErrorHandlers();
  }
  
  static getInstance(): DeviceLogger {
    if (!DeviceLogger.instance) {
      DeviceLogger.instance = new DeviceLogger();
    }
    return DeviceLogger.instance;
  }
  
  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private generateCorrelationId(): string {
    return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private setupErrorHandlers() {
    // Catch unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.error(LogCategory.ERROR_RECOVERY, 'Unhandled promise rejection', {
        reason: event.reason,
        promise: event.promise
      });
    });
    
    // Catch global errors
    window.addEventListener('error', (event) => {
      this.error(LogCategory.ERROR_RECOVERY, 'Global error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
      });
    });
  }
  
  startCorrelation(correlationId?: string): string {
    this.correlationId = correlationId || this.generateCorrelationId();
    this.debug(LogCategory.DEVICE_CONNECTION, `Starting correlated operation: ${this.correlationId}`);
    return this.correlationId;
  }
  
  endCorrelation() {
    if (this.correlationId) {
      this.debug(LogCategory.DEVICE_CONNECTION, `Ending correlated operation: ${this.correlationId}`);
      this.correlationId = null;
    }
  }
  
  private createLogEntry(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: any
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      correlationId: this.correlationId || undefined,
      component: this.getCallingComponent(),
      data: data ? this.sanitizeData(data) : undefined
    };
    
    // Extract device IDs if present in data
    if (data) {
      if (data.deviceId) entry.deviceId = data.deviceId;
      if (data.placeholderId) entry.placeholderId = data.placeholderId;
      if (data.error) {
        entry.error = {
          message: data.error.message || data.error.toString(),
          stack: data.error.stack,
          code: data.error.code
        };
      }
    }
    
    return entry;
  }
  
  private getCallingComponent(): string {
    // Try to extract component name from stack trace
    const stack = new Error().stack;
    if (stack) {
      const lines = stack.split('\n');
      // Skip first 3 lines (Error, createLogEntry, log method)
      const callerLine = lines[4];
      if (callerLine) {
        const match = callerLine.match(/at\s+(\S+)/);
        if (match) {
          return match[1].split('.')[0]; // Get component name
        }
      }
    }
    return 'Unknown';
  }
  
  private sanitizeData(data: any): any {
    // Remove sensitive information
    const sensitiveKeys = ['pin', 'passphrase', 'seedPhrase', 'privateKey', 'password'];
    
    const sanitize = (obj: any): any => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj !== 'object') return obj;
      
      if (Array.isArray(obj)) {
        return obj.map(sanitize);
      }
      
      const sanitized: any = {};
      for (const key in obj) {
        if (sensitiveKeys.includes(key.toLowerCase())) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = sanitize(obj[key]);
        }
      }
      return sanitized;
    };
    
    return sanitize(data);
  }
  
  private log(level: LogLevel, category: LogCategory, message: string, data?: any) {
    if (level > this.currentLevel) return;
    
    const entry = this.createLogEntry(level, category, message, data);
    this.logs.push(entry);
    
    // Keep only last 1000 entries
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-1000);
    }
    
    // Console output with color coding
    const levelColors = {
      [LogLevel.ERROR]: 'color: red; font-weight: bold',
      [LogLevel.WARN]: 'color: orange; font-weight: bold',
      [LogLevel.INFO]: 'color: blue',
      [LogLevel.DEBUG]: 'color: gray',
      [LogLevel.TRACE]: 'color: lightgray'
    };
    
    const levelNames = {
      [LogLevel.ERROR]: '❌ ERROR',
      [LogLevel.WARN]: '⚠️  WARN',
      [LogLevel.INFO]: 'ℹ️  INFO',
      [LogLevel.DEBUG]: '🔧 DEBUG',
      [LogLevel.TRACE]: '📍 TRACE'
    };
    
    console.log(
      `%c${levelNames[level]} [${category}]${this.correlationId ? ` [${this.correlationId}]` : ''}: ${message}`,
      levelColors[level],
      data || ''
    );
  }
  
  error(category: LogCategory, message: string, data?: any) {
    this.log(LogLevel.ERROR, category, message, data);
  }
  
  warn(category: LogCategory, message: string, data?: any) {
    this.log(LogLevel.WARN, category, message, data);
  }
  
  info(category: LogCategory, message: string, data?: any) {
    this.log(LogLevel.INFO, category, message, data);
  }
  
  debug(category: LogCategory, message: string, data?: any) {
    this.log(LogLevel.DEBUG, category, message, data);
  }
  
  trace(category: LogCategory, message: string, data?: any) {
    this.log(LogLevel.TRACE, category, message, data);
  }
  
  // Specialized logging methods
  logDeviceConnection(deviceId: string, status: string, data?: any) {
    this.info(LogCategory.DEVICE_CONNECTION, `Device ${deviceId}: ${status}`, {
      deviceId,
      ...data
    });
  }
  
  logDeviceIdMapping(placeholderId: string, realId: string | null, data?: any) {
    this.info(LogCategory.DEVICE_ID, `ID Mapping: ${placeholderId} -> ${realId || 'pending'}`, {
      placeholderId,
      realId,
      ...data
    });
  }
  
  logStateConflict(description: string, states: any) {
    this.warn(LogCategory.STATE_CONFLICT, description, states);
  }
  
  logUIError(component: string, error: Error, data?: any) {
    this.error(LogCategory.UI_ERROR, `UI Error in ${component}: ${error.message}`, {
      component,
      error,
      ...data
    });
  }
  
  logEvent(eventType: 'received' | 'emitted', eventName: string, payload?: any) {
    const category = eventType === 'received' ? LogCategory.EVENT_RECEIVED : LogCategory.EVENT_EMITTED;
    this.debug(category, `Event ${eventType}: ${eventName}`, payload);
  }
  
  // Export logs for debugging
  exportLogs(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      logs: this.logs
    }, null, 2);
  }
  
  clearLogs() {
    this.logs = [];
  }
  
  setLogLevel(level: LogLevel) {
    this.currentLevel = level;
  }
}

// Export singleton instance
export const deviceLogger = DeviceLogger.getInstance();

// Export convenience functions
export const logDevice = (message: string, data?: any) => 
  deviceLogger.info(LogCategory.DEVICE_CONNECTION, message, data);

export const logDeviceError = (message: string, error: any) => 
  deviceLogger.error(LogCategory.DEVICE_CONNECTION, message, { error });

export const logUIError = (component: string, error: Error, data?: any) => 
  deviceLogger.logUIError(component, error, data);

export const logStateChange = (component: string, oldState: any, newState: any) => 
  deviceLogger.debug(LogCategory.STATE_CHANGE, `${component} state change`, { oldState, newState });