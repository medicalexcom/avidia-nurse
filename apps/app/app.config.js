/**
 * Dynamic Expo config. Extends app.json and allows CI to set a base URL when
 * the web build is hosted under a sub-path (e.g. GitHub Pages serves the app
 * at https://<org>.github.io/avidia-nurse/, so EXPO_BASE_URL=/avidia-nurse).
 * Local builds are unaffected when EXPO_BASE_URL is unset.
 */
module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    ...(process.env.EXPO_BASE_URL ? { baseUrl: process.env.EXPO_BASE_URL } : {}),
  },
});
