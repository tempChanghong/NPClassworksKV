import dotenv from "dotenv";

dotenv.config();

export const isDevelopment = process.env.NODE_ENV === "development";
