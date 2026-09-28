/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testTimeout: 180000,
  maxWorkers: 1,
  roots: ["<rootDir>/tests"],
  moduleNameMapper: {
    "^@rideflow/shared$": "<rootDir>/../../packages/shared/src/index.ts",
  },
};
