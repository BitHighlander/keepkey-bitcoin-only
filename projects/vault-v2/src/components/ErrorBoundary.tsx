import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Box, VStack, Text, Button, Code, Collapse } from '@chakra-ui/react';
import { deviceLogger, LogCategory } from '../utils/deviceLogger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  componentName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
  correlationId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      correlationId: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const correlationId = deviceLogger.startCorrelation();
    
    // Log the error with full context
    deviceLogger.error(LogCategory.ERROR_BOUNDARY, `React Error in ${this.props.componentName || 'Unknown Component'}`, {
      component: this.props.componentName,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      },
      errorInfo: {
        componentStack: errorInfo.componentStack
      },
      props: this.sanitizeProps(this.props),
      state: this.state
    });
    
    // Check for specific error patterns
    if (error.message.includes('React.Children.only')) {
      deviceLogger.error(LogCategory.UI_ERROR, 'React.Children.only error detected - component expects single child', {
        component: this.props.componentName,
        childrenType: typeof this.props.children,
        childrenArray: Array.isArray(this.props.children),
        childrenCount: React.Children.count(this.props.children)
      });
    }
    
    deviceLogger.endCorrelation();
    
    this.setState({
      errorInfo,
      correlationId
    });
  }
  
  private sanitizeProps(props: any): any {
    // Remove children and functions from props for logging
    const sanitized: any = {};
    for (const key in props) {
      if (key !== 'children' && typeof props[key] !== 'function') {
        sanitized[key] = props[key];
      }
    }
    return sanitized;
  }

  handleReset = () => {
    deviceLogger.info(LogCategory.ERROR_RECOVERY, 'Error boundary reset by user', {
      component: this.props.componentName,
      correlationId: this.state.correlationId
    });
    
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
      correlationId: null
    });
  };

  toggleDetails = () => {
    this.setState(prev => ({ showDetails: !prev.showDetails }));
  };

  exportLogs = () => {
    const logs = deviceLogger.exportLogs();
    const blob = new Blob([logs], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `keepkey-error-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  render() {
    if (this.state.hasError) {
      // If a custom fallback is provided, use it
      if (this.props.fallback) {
        return <>{this.props.fallback}</>;
      }

      // Default error UI
      return (
        <Box p={6} bg="red.900" borderRadius="lg" borderWidth="1px" borderColor="red.700">
          <VStack spacing={4} align="stretch">
            <Text fontSize="xl" fontWeight="bold" color="red.200">
              ⚠️ Something went wrong
            </Text>
            
            <Text color="red.100">
              {this.state.error?.message || 'An unexpected error occurred'}
            </Text>
            
            {this.props.componentName && (
              <Text fontSize="sm" color="red.300">
                Component: {this.props.componentName}
              </Text>
            )}
            
            {this.state.correlationId && (
              <Text fontSize="xs" color="red.400" fontFamily="mono">
                Error ID: {this.state.correlationId}
              </Text>
            )}
            
            <Box>
              <Button 
                size="sm" 
                variant="outline" 
                colorScheme="red"
                onClick={this.toggleDetails}
                mr={2}
              >
                {this.state.showDetails ? 'Hide' : 'Show'} Details
              </Button>
              
              <Button 
                size="sm" 
                variant="outline" 
                colorScheme="red"
                onClick={this.exportLogs}
                mr={2}
              >
                Export Logs
              </Button>
              
              <Button 
                size="sm" 
                colorScheme="red"
                onClick={this.handleReset}
              >
                Try Again
              </Button>
            </Box>
            
            <Collapse in={this.state.showDetails}>
              <Box 
                mt={4} 
                p={3} 
                bg="gray.900" 
                borderRadius="md"
                maxH="300px"
                overflowY="auto"
              >
                <Text fontSize="sm" fontWeight="bold" color="red.300" mb={2}>
                  Stack Trace:
                </Text>
                <Code 
                  display="block" 
                  whiteSpace="pre-wrap" 
                  fontSize="xs"
                  color="red.100"
                >
                  {this.state.error?.stack}
                </Code>
                
                {this.state.errorInfo && (
                  <>
                    <Text fontSize="sm" fontWeight="bold" color="red.300" mt={4} mb={2}>
                      Component Stack:
                    </Text>
                    <Code 
                      display="block" 
                      whiteSpace="pre-wrap" 
                      fontSize="xs"
                      color="red.100"
                    >
                      {this.state.errorInfo.componentStack}
                    </Code>
                  </>
                )}
              </Box>
            </Collapse>
          </VStack>
        </Box>
      );
    }

    return this.props.children;
  }
}

// HOC for easier usage
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  componentName?: string
) {
  return (props: P) => (
    <ErrorBoundary componentName={componentName || Component.displayName || Component.name}>
      <Component {...props} />
    </ErrorBoundary>
  );
}