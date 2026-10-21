/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "mytube",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "local",
      providers: {
        cloudflare: {
          package: "@pulumi/cloudflare",
          version: "6.20.0",
        },
      },
    };
  },

  async run() {
    return {};
  },
});
