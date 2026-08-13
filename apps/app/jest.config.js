/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src'],
  // AsyncStorage's native module does not exist under Jest; use its official mock.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // The first test in a suite pays the full module-load + first-render cost,
  // which can exceed Jest's 5 s default on slow CI runners.
  testTimeout: 20000,
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg)',
  ],
};
