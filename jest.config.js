module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@op-engineering/op-sqlite)/)',
  ],
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
