
# R2 Image Host Worker · API 上传使用文档

本文档聚焦**上传相关接口**的完整使用说明。所有接口与 Node 版保持一致，可按部署环境互换。

> 基础地址：`https://<你的-worker-域名>`（如 `https://r2-image-host.xxx.workers.dev` 或自定义域名）

> 鉴权方式：除 `/api/config` 外，所有接口均需通过 `x-upload-token` / `x-delete-token` 请求头传递口令

---

## 一、接口总览

| 方法 | 路径 | 鉴权头 | Content-Type | 说明 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/upload` | `x-upload-token` | `multipart/form-data` | 上传图片（支持多文件） |
| `POST` | `/api/delete` | `x-delete-token` | `application/json` | 删除图片 |
| `GET` | `/api/list` | `x-upload-token` | — | 历史清单（列桶） |
| `GET` | `/api/config` | 无 | — | 公开配置（匿名可读） |
| `GET` | `/api/health` | `x-upload-token` | — | 健康检查 + 配置详情 |
| `GET` | `/api/diag` | `x-upload-token` | — | 配置体检 / 定点 key 诊断 |
| `GET` | `/i/<key>` | 无 | — | 图片兜底读取（未绑域名时） |

> 上传模式由服务端 `UPLOAD_MODE` 决定：`direct`（默认）或 `presign`。客户端可先调 `/api/config` 获知当前模式。

---

## 二、鉴权

配置了 `UPLOAD_TOKEN` 后，上传/列桶/诊断接口必须携带该口令：
