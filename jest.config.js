module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@op-engineering/op-sqlite)/)',
  ],
  testEnvironmentOptions: {
    customExportConditions: ['node'],
  },
};
