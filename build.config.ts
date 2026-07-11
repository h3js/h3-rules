import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts", "./src/cache.ts", "./src/proxy.ts", "./src/compiler.ts"],
    },
  ],
});
