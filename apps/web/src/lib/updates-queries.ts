import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/* Queries for the updates module (E1.4): admin (posts, sends, settings, domain) and investor (archive). */
export type UpdatePost = FundRoomSchemas["UpdatePost"];
export type UpdatePostDetail = FundRoomSchemas["UpdatePostDetail"];
export type UpdateSend = FundRoomSchemas["UpdateSend"];
export type UpdateRecipient = FundRoomSchemas["UpdateRecipient"];
export type UpdateTemplate = FundRoomSchemas["UpdateTemplate"];
export type UpdateAudience = FundRoomSchemas["UpdateAudience"];
export type UpdateSectionRule = FundRoomSchemas["UpdateSectionRule"];
export type UpdateArchiveEntry = FundRoomSchemas["UpdateArchiveEntry"];
export type UpdateArchivePage = FundRoomSchemas["UpdateArchivePage"];
export type UpdateThread = FundRoomSchemas["UpdateThread"];
export type UpdateReply = FundRoomSchemas["UpdateReply"];
export type UpdatesSettings = FundRoomSchemas["UpdatesSettings"];
export type SendingDomain = FundRoomSchemas["SendingDomain"];
export type PageDoc = FundRoomSchemas["PageDoc"];
export type PageSection = FundRoomSchemas["Section"];
export type PageBlock = FundRoomSchemas["Block"];

export const updatePostsQuery = queryOptions({
  queryKey: ["updates", "posts"],
  queryFn: () => call(api().GET("/updates/posts")),
});

export function updatePostQuery(id: string) {
  return queryOptions({
    queryKey: ["updates", "post", id],
    queryFn: () => call(api().GET("/updates/posts/{id}", { params: { path: { id } } })),
  });
}

export function updateSendsQuery(id: string) {
  return queryOptions({
    queryKey: ["updates", "post", id, "sends"],
    queryFn: () => call(api().GET("/updates/posts/{id}/sends", { params: { path: { id } } })),
  });
}

export function updateRecipientsQuery(sendId: string) {
  return queryOptions({
    queryKey: ["updates", "send", sendId, "recipients"],
    queryFn: () =>
      call(api().GET("/updates/sends/{sendId}/recipients", { params: { path: { sendId } } })),
  });
}

export function updateThreadsQuery(id: string) {
  return queryOptions({
    queryKey: ["updates", "post", id, "replies"],
    queryFn: () => call(api().GET("/updates/posts/{id}/replies", { params: { path: { id } } })),
  });
}

export const updateTemplatesQuery = queryOptions({
  queryKey: ["updates", "templates"],
  queryFn: () => call(api().GET("/updates/templates")),
});

export const updatesSettingsQuery = queryOptions({
  queryKey: ["updates", "settings"],
  queryFn: () => call(api().GET("/updates/settings")),
});

export const sendingDomainQuery = queryOptions({
  queryKey: ["updates", "sending-domain"],
  queryFn: () => call(api().GET("/updates/sending-domain")),
});

export const updateArchiveQuery = queryOptions({
  queryKey: ["updates", "archive"],
  queryFn: () => call(api().GET("/updates/archive")),
});

export function updateArchivePageQuery(slug: string) {
  return queryOptions({
    queryKey: ["updates", "archive", slug],
    queryFn: () => call(api().GET("/updates/archive/{slug}", { params: { path: { slug } } })),
  });
}
