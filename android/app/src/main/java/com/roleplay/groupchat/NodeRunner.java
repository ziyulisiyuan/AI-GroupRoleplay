package com.roleplay.groupchat;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.util.Map;

/**
 * 本地 Node 服务的进程宿主：把捆绑的 Node 运行时（jniLibs/libnodeexec.so）作为**本应用进程的子进程**拉起。
 *
 * 为什么不用前台服务（v10 起）：Android 强制前台服务必须常驻一条通知，而本服务唯一的使用者就是
 * 本应用的界面 —— 保活收益为零、通知却是纯噪音（真机反馈"每次打开都弹"）。因此改为随界面起落：
 * Activity 创建时启动、销毁时结束；应用被系统回收时服务一并消失，下次进入重新拉起（约 1 秒）。
 *
 * 为什么 node 二进制放在 jniLibs：Android 10+ 禁止执行应用数据目录里的文件，只有
 * nativeLibraryDir（安装器解包的 APK lib 目录）里的文件可执行；依赖库靠 LD_LIBRARY_PATH 解析。
 * 服务只绑 127.0.0.1（HOST_BIND），局域网内其他设备无法访问。
 */
final class NodeRunner {
    private static final String TAG = "NodeRunner";
    private static Process proc;

    private NodeRunner() {}

    static synchronized boolean running() {
        return proc != null && proc.isAlive();
    }

    /** 启动 node（幂等：已在运行则直接返回 true）。调用方需在后台线程执行（解包 + 拉起有耗时）。 */
    static synchronized boolean start(Context ctx) {
        if (running()) return true;
        try {
            Payload.ensureExtracted(ctx);
        } catch (Exception e) {
            Log.e(TAG, "payload 解包失败", e);
            return false;
        }
        try {
            return spawn(ctx);
        } catch (Exception e) {
            Log.e(TAG, "node 启动失败", e);
            return false;
        }
    }

    static synchronized void stop() {
        if (proc != null) {
            proc.destroy();
            proc = null;
            Log.i(TAG, "node 已停止");
        }
    }

    private static boolean spawn(Context ctx) throws Exception {
        File appDir = Payload.appDir(ctx);
        File serverJs = Payload.serverJs(ctx);
        if (!serverJs.exists()) {
            Log.e(TAG, "缺少 " + serverJs.getAbsolutePath());
            return false;
        }
        String libDir = ctx.getApplicationInfo().nativeLibraryDir;
        File nodeBin = new File(libDir, "libnodeexec.so");
        if (!nodeBin.canExecute()) {
            Log.e(TAG, "node 运行时不可执行: " + nodeBin + "（nativeLibraryDir 未解包？）");
        }
        ProcessBuilder pb = new ProcessBuilder(nodeBin.getAbsolutePath(), serverJs.getAbsolutePath());
        pb.directory(appDir);
        pb.redirectErrorStream(true);
        File log = Payload.logFile(ctx);
        // 日志无界增长防护：超过 1MB 就重开（node 每次启动只写几行，正常几个月也到不了）
        if (log.exists() && log.length() > 1024 * 1024) {
            //noinspection ResultOfMethodCallIgnored
            log.delete();
        }
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        Map<String, String> env = pb.environment();
        env.put("LD_LIBRARY_PATH", libDir);
        env.put("HOME", ctx.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
        env.put("HOST_PORT", "8787");
        env.put("HOST_BIND", "127.0.0.1"); // 只绑回环：局域网不可见
        proc = pb.start();
        Log.i(TAG, "node 已启动（作为应用进程的子进程）");
        return true;
    }
}
