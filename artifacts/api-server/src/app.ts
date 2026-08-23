import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const configuredOrigins = process.env.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
const allowedOrigins = [...new Set([
  "https://pagewoga.online",
  "https://admin.pagewoga.online",
  ...configuredOrigins,
])];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", router);

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  req.log.error(
    { err: error instanceof Error ? error.message : String(error), method: req.method, path: req.path },
    "Unhandled API error.",
  );
  if (res.headersSent) return;
  res.status(500).json({ code: "INTERNAL_ERROR", message: "An unexpected server error occurred." });
};

app.use(errorHandler);

export default app;
