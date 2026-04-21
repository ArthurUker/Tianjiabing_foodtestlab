module.exports = {
  testEnvironment: "jsdom",
  roots: [
    "<rootDir>/tests",
    "<rootDir>/backend"
  ],
  testMatch: [
    "**/tests/**/*.test.js",
    "**/backend/**/*.test.js"
  ],
  collectCoverageFrom: [
    "js/**/*.js",
    "backend/**/*.js",
    "!**/node_modules/**",
    "!**/tests/**",
    "!**/dist/**"
  ],

  setupFilesAfterEnv: [
    "<rootDir>/tests/setup.js"
  ],
  moduleNameMapper: {
    "^@/utils/(.*)$": "<rootDir>/js/utils/$1",
    "^@/modules/(.*)$": "<rootDir>/js/modules/$1",
    "^@/core/(.*)$": "<rootDir>/js/core/$1"
  },
  transform: {
    "^.+\\.js$": "babel-jest"
  },
  verbose: true,
  testTimeout: 10000
};

