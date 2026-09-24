package com.roleplay.groupchat;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * payload（server.mjs + 前端 dist）的落地与目录约定。
 *
 * 目录约定（与后端 config.ts 的 root 推导严格对齐）：
 *   config.root = server.mjs 所在目录的父目录 → filesDir
 *   于是 groups/  settings.yaml  规则.md  dist/  全部落在 filesDir 下，
 *   与 PC 工作区的布局一一对应，后端零改动即可识别。
 *
 *   filesDir/app/server.mjs   ← payload（可覆盖升级）
 *   filesDir/dist/            ← 前端构建产物
 *   filesDir/groups/          ← 数据（用户资产，永不随 payload 覆盖删除）
 *   filesDir/settings.yaml    ← 由界面里配置密钥后生成
 */
final class Payload {
    static final String TAG = "Payload";
    /** payload 版本：改动前端/后端后要 +1，启动时才会重新解包。 */
    static final String VERSION = "14";

    private Payload() {}

    static File dataRoot(Context ctx) {
        return ctx.getFilesDir();
    }

    static File appDir(Context ctx) {
        return new File(ctx.getFilesDir(), "app");
    }

    static File serverJs(Context ctx) {
        return new File(appDir(ctx), "server.mjs");
    }

    static File logFile(Context ctx) {
        return new File(appDir(ctx), "server.log");
    }

    /** 首次启动或 payload 版本变化时解包；数据目录不受影响。 */
    static synchronized void ensureExtracted(Context ctx) throws IOException {
        File appDir = appDir(ctx);
        File marker = new File(appDir, ".payload-version");
        if (serverJs(ctx).exists() && marker.exists() && VERSION.equals(readText(marker))) {
            Log.i(TAG, "payload 已是最新，跳过解包");
            return;
        }
        appDir.mkdirs();
        new File(ctx.getFilesDir(), "groups").mkdirs();
        Log.i(TAG, "解包 payload.zip …");
        AssetManager am = ctx.getAssets();
        try (ZipInputStream zin = new ZipInputStream(am.open("payload.zip"))) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = zin.getNextEntry()) != null) {
                // 兼容 Windows 侧压缩工具写出的反斜杠条目名（Linux 上反斜杠不是分隔符）
                String name = e.getName().replace('\\', '/');
                if (name.isEmpty()) continue;
                File out = safeResolve(ctx, name);
                if (out == null) continue;
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
        // 只覆盖 payload 自身文件；groups/ 与 settings.yaml 从未被打进 payload，天然不受影响
        writeText(marker, VERSION);
        Log.i(TAG, "payload 解包完成");
    }

    /** 防路径穿越：解包目标必须落在 filesDir 内。 */
    private static File safeResolve(Context ctx, String name) throws IOException {
        File f = new File(ctx.getFilesDir(), name);
        String base = ctx.getFilesDir().getCanonicalPath();
        String path = f.getCanonicalPath();
        if (!path.startsWith(base)) {
            Log.w(TAG, "跳过越界条目: " + name);
            return null;
        }
        return f;
    }

    private static String readText(File f) throws IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n < 0) break;
                off += n;
            }
            return new String(b, 0, off, java.nio.charset.StandardCharsets.UTF_8).trim();
        }
    }

    private static void writeText(File f, String text) throws IOException {
        try (OutputStream os = new FileOutputStream(f)) {
            os.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
    }
}
