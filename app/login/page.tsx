"use client";

import { signIn } from "next-auth/react";
import { LayoutGrid } from "lucide-react";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-sm p-8 space-y-6">
        {/* 로고 */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 bg-blue-500 rounded-2xl flex items-center justify-center">
            <LayoutGrid size={28} className="text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-gray-900">VanaM 인사·근태</h1>
            <p className="text-sm text-gray-400 mt-1">VanaM HR System</p>
          </div>
        </div>

        <hr className="border-gray-100" />

        <div className="space-y-3">
          <p className="text-sm text-center text-gray-500">Google 계정으로 로그인하세요</p>
          <button
            onClick={() => signIn("google", { callbackUrl: "/" })}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
              <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
            </svg>
            Google로 로그인
          </button>
        </div>

        <p className="text-xs text-center text-gray-400">
          등록된 계정으로만 로그인 가능합니다
        </p>
      </div>
    </div>
  );
}
