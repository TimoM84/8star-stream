"use strict";
// 8star Stream — livestream platform. Starts the app; see README.md.
// Copyright © 2026 Timo Manders. All rights reserved.
const { createApp } = require("./src/app");

createApp()
  .then(async (app) => {
    const port = await app.listen();
    console.log(new Date().toISOString(), "8star Stream " + app.version + " listening on port " + port);
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  })
  .catch((e) => {
    console.error(new Date().toISOString(), "start failed:", e.message);
    process.exit(1);
  });
