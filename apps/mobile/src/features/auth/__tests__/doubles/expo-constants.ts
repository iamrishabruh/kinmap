/**
 * `expo-constants`, carrying the deployed development pool's public
 * identifiers. All three are readable from any installed binary, so there is
 * nothing here that a test could leak.
 */
export default {
  expoConfig: {
    version: '0.1.0',
    extra: {
      appEnv: 'development',
      apiBaseUrl: 'https://api.dev.kinmap.app',
      cognitoUserPoolId: 'us-east-1_XXXXXXXXX',
      cognitoClientId: 'xxxxxxxxxxxxxxxxxxxxxxxxxx',
      cognitoDomain: 'kinmap-development-000000000000',
      awsRegion: 'us-east-1',
    },
  },
};
