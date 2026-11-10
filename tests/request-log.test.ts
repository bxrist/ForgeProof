import { expect, it } from "vitest";
import { requestLogLine } from "../server/requestLog";

it("logs route templates without request or response credentials and identities", () => {
  const request = {
    method: "POST", route: {path:"/api/keys/:id"},
    path:"/api/keys/private-identity", originalUrl:"/api/keys/private-identity?token=private-token",
    headers: {authorization:"Bearer private-token"}, body:{key:"private-key"},
  };
  expect(requestLogLine(request,201,8)).toBe("POST /api/keys/:id 201 in 8ms");
  expect(requestLogLine({...request,route:undefined},404,2))
    .toBe("POST (unmatched API route) 404 in 2ms");
});
