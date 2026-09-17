module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@op-engineering/op-sqlite|react-native-gesture-handler)/)',
  ],
  // react-native-gesture-handler's native module doesn't exist under plain
  // Jest (no native binary), so importing it eagerly throws a
  // TurboModuleRegistry invariant violation unless its own official mocks
  // are installed first. setupFilesAfterEnv (not setupFiles) is used so
  // this doesn't clobber @react-native/jest-preset's own setupFiles entry
  // below -- Jest replaces same-key arrays between preset and project
  // config rather than merging them.
  setupFilesAfterEnv: ['react-native-gesture-handler/jestSetup'],
  // @react-native/jest-preset's custom test environment (jest/react-native-env.js)
  // hard-codes `customExportConditions` as a class field, so a top-level
  // `customExportConditions` key here is silently ignored (or rejected as an
  // "Unknown option") and is NOT the override point. Only
  // testEnvironmentOptions.customExportConditions reaches that environment's
  // constructor and overrides its default. Without this nesting, op-sqlite's
  // package.json "node" export condition never matches and resolution falls
  // through to its React Native build, which throws under plain Jest/Node.
  testEnvironmentOptions: {
    customExportConditions: ['node'],
  },
};
