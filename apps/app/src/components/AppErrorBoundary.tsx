import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../ui/theme';

/**
 * Root error boundary (M14 spec AV): an unexpected render error shows a
 * recoverable screen instead of a white page / dead app. The error is logged
 * WITHOUT any course content, question text or user data — component stacks
 * only (spec AF/AH). When a crash-reporting DSN is configured this is the
 * single choke point where those reports would be sent (ADR-0038).
 */

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Structured, content-free logging: error name/message and the component
    // stack are framework internals, never user data.
    console.error(
      JSON.stringify({
        level: 'error',
        source: 'AppErrorBoundary',
        name: error.name,
        message: error.message,
        componentStack: info.componentStack?.slice(0, 2000) ?? null,
      })
    );
  }

  private reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container} testID="app-error-boundary">
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            The app hit an unexpected error. Your study data is safe on the server — nothing was
            lost.
          </Text>
          <Pressable accessibilityRole="button" onPress={this.reset} style={styles.button}>
            <Text style={styles.buttonLabel}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing(6),
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: spacing(3) },
  body: {
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing(6),
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingHorizontal: spacing(6),
    paddingVertical: spacing(3),
  },
  buttonLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
