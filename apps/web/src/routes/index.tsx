import { createFileRoute } from "@tanstack/react-router";
import { WebProduct } from "../product/WebProduct.tsx";

export const Route = createFileRoute("/")({ component: WebProduct });
