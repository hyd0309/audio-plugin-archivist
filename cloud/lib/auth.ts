
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { env } from "cloudflare:workers";

import { getDb } from "../db";
import * as schema from "../db/schema";
import { APP_PATH } from "./paths";

const runtimeEnv = env as typeof env & {
  BETTER_AUTH_SECRET: string;
};

export const auth = betterAuth({
  appName: "Audio Plugin Archive",

  // 对外访问地址仍然是个人网站，不暴露 Worker 地址。
  baseURL: "https://huangyd.is-a.dev",

  // Pages Function 转发到 Worker 后，API 路径仍包含 /plugin-archive。
  basePath: `${APP_PATH}/api/auth`,

  secret: runtimeEnv.BETTER_AUTH_SECRET,

  database: drizzleAdapter(getDb(), {
    provider: "sqlite",
    schema,
  }),

  // 第一阶段先开放邮箱和密码注册、登录。
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },

  trustedOrigins: [
    "https://huangyd.is-a.dev",
  ],

  advanced: {
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip"],
    },
  },
});
