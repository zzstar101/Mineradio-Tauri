import React from "react";
import { createRoot } from "react-dom/client";
import { M4ParityRoot } from "./M4ParityRoot";
import "./m4-fixture.css";

const host = document.getElementById("root");
if (!host) throw new Error("M4 engine smoke fixture root is missing");

createRoot(host).render(
	<React.StrictMode>
		<M4ParityRoot />
	</React.StrictMode>,
);
