/* ============================================================
   CASEFILE — Cyber Forensic Terminal & Operative Toolkit
   Cyber Dark Theme Interactive Environment
   Supporting BASH CLI, Hex, Base64, ROT13, URL Percent, Morse,
   Binary, XOR, and Git Forensics.
   Features a sidebar tool selection list, instant search, and
   window minimize / restore / maximize controls.
   ============================================================ */

(() => {
  'use strict';

  let terminalOpen = false;
  let isMinimized = false;
  let isMaximized = false;
  let selectedToolId = 'terminal'; // default active tool
  let commandHistory = [];
  let historyIndex = -1;
  const minimizedToolIds = new Set();

  // Mock Filesystem & Git Repository state
  const GIT_REPO = {
    branch: 'main',
    commits: [
      {
        hash: '3c9b4e1',
        fullHash: '3c9b4e198a2e1d0f5c6b8a7d9e1f2a3b4c5d6e7f',
        author: 'nullbyte_47 <r4ven@void-sec.org>',
        date: 'Sat Oct 17 01:42:19 2026 -0400',
        message: 'clean up repository readme and assets',
        diff: `diff --git a/README.md b/README.md
index 48a291b..981b2a4 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
-# Operation Midnight
+# Operation Midnight [OFFLINE]
-Experimental research staging
+All systems migrated.`
      },
      {
        hash: 'a7f3d2b',
        fullHash: 'a7f3d2b4892c90fa1b5e28a1c893df82910fae12',
        author: 'r4ven-sec <nullbyte_47@void-corp>',
        date: 'Wed Oct 14 03:12:04 2026 -0400',
        message: 'sec-fix: scrub hardcoded test keys and local env config',
        diff: `diff --git a/credentials.txt.bak b/credentials.txt.bak
deleted file mode 100644
index 718bf41..0000000
--- a/credentials.txt.bak
+++ /dev/null
@@ -1,4 +0,0 @@
-# STAGING CREDENTIAL ARCHIVE // DECLASSIFIED
-# CI/CD AUTOMATION PRE-FLIGHT
-ROT13: SYNT{GUR_CNFFJBEQ_JNF_VA_GUR_PBZZVG}
-Target Perimeter: oxraventest.com`
      },
      {
        hash: '8f192aa',
        fullHash: '8f192aa6172bc90a44ef291a8c901e4a7b2190ab',
        author: 'r4ven-sec <nullbyte_47@void-corp>',
        date: 'Mon Oct 12 19:04:12 2026 -0400',
        message: 'initial commit - operation midnight core',
        diff: `diff --git a/app.py b/app.py
new file mode 100644
index 0000000..3a19e42
--- /dev/null
+++ b/app.py
@@ -0,0 +1,10 @@
+from flask import Flask
+app = Flask(__name__)
+@app.route('/')
+def home(): return '0xRAVEN Core Active'`
      }
    ]
  };

  // Morse Code mappings
  const MORSE_MAP = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.', 'F': '..-.',
    'G': '--.', 'H': '....', 'I': '..', 'J': '.---', 'K': '-.-', 'L': '.-..',
    'M': '--', 'N': '-.', 'O': '---', 'P': '.--.', 'Q': '--.-', 'R': '.-.',
    'S': '...', 'T': '-', 'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-',
    'Y': '-.--', 'Z': '--..', '1': '.----', '2': '..---', '3': '...--',
    '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..',
    '9': '----.', '0': '-----', '{': '{', '}': '}', '_': '_'
  };
  const REVERSE_MORSE = {};
  for (let k in MORSE_MAP) REVERSE_MORSE[MORSE_MAP[k]] = k;

  function decodeMorse(morseStr) {
    if (!morseStr) return '';
    let s = morseStr.trim();
    // Normalize word breaks: slashes, pipes, or underscores with spaces delineate words
    s = s.replace(/\s*[\/|]\s*/g, '   ');
    // Split into words by 2 or more whitespace characters, or newlines
    const words = s.split(/\s{2,}|\n+/);
    return words.map(word => {
      return word.trim().split(/\s+/).filter(Boolean).map(code => {
        if (code === '{' || code === '}' || code === '_') return code;
        return REVERSE_MORSE[code] || '?';
      }).join('');
    }).filter(Boolean).join(' ');
  }

  function encodeMorse(text) {
    if (!text) return '';
    return text.toUpperCase().trim().split(/\s+/).map(word => {
      return word.split('').map(c => MORSE_MAP[c] || c).join(' ');
    }).join('   ');
  }

  if (typeof window !== 'undefined') {
    window.decodeMorse = decodeMorse;
    window.encodeMorse = encodeMorse;
  }

  function rot13(str, shift = 13) {
    return str.replace(/[a-zA-Z]/g, function (c) {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - base + shift) % 26 + base);
    });
  }

  function hexToAscii(hexStr) {
    const clean = hexStr.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    let str = '';
    for (let i = 0; i < clean.length; i += 2) {
      str += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
    }
    return str;
  }

  function asciiToHex(asciiStr) {
    return asciiStr.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  function binaryToAscii(binStr) {
    const clean = binStr.replace(/[^01]/g, '');
    let str = '';
    for (let i = 0; i < clean.length; i += 8) {
      const byte = clean.substr(i, 8);
      if (byte.length === 8) {
        str += String.fromCharCode(parseInt(byte, 2));
      }
    }
    return str;
  }

  function asciiToBinary(asciiStr) {
    return asciiStr.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
  }

  function decodeUrlPercent(str) {
    return decodeURIComponent(str.replace(/\+/g, ' '));
  }

  function encodeUrlPercent(str) {
    return Array.from(str).map(c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  }

  // Master Tools Directory with categories and refined light-theme styling
  const CATEGORIES = [
    'COMMAND LINE & SHELL',
    'CIPHERS & CRYPTOGRAPHY',
    'ENCODING & SIGNALS',
    'VERSION CONTROL'
  ];

  const TOOLS_LIST = [
    {
      id: 'terminal',
      category: 'COMMAND LINE & SHELL',
      name: 'Interactive BASH CLI',
      badge: 'CLI',
      badgeColor: 'text-purple-300 bg-purple-950/80 border-purple-800',
      icon: 'terminal',
      iconBg: 'bg-purple-950/90 text-purple-300 border border-purple-800/60',
      desc: 'Command prompt sandbox for git, hex, base64, rot13, curl & logs.',
      searchKeywords: 'terminal bash cli command line shell sh console prompt run'
    },
    {
      id: 'base64',
      category: 'CIPHERS & CRYPTOGRAPHY',
      name: 'Base64 Token Decoder',
      badge: 'B64',
      badgeColor: 'text-emerald-300 bg-emerald-950/80 border-emerald-800',
      icon: 'lock_open',
      iconBg: 'bg-emerald-950/90 text-emerald-300 border border-emerald-800/60',
      desc: 'Decode/encode RFC 4648 Base64 strings with padding support.',
      searchKeywords: 'base64 b64 token decode encode session auth atob btoa'
    },
    {
      id: 'rot13',
      category: 'CIPHERS & CRYPTOGRAPHY',
      name: 'ROT13 / Caesar Cipher',
      badge: 'ROT13',
      badgeColor: 'text-amber-300 bg-amber-950/80 border-amber-800',
      icon: 'sync',
      iconBg: 'bg-amber-950/90 text-amber-300 border border-amber-800/60',
      desc: 'Rotate alphabet by 13 positions or custom Caesar offsets.',
      searchKeywords: 'rot13 caesar cipher substitution shift rotate alphabet decode'
    },
    {
      id: 'hex',
      category: 'CIPHERS & CRYPTOGRAPHY',
      name: 'Hexadecimal (HEX)',
      badge: '0x...',
      badgeColor: 'text-cyan-300 bg-cyan-950/80 border-cyan-800',
      icon: 'memory',
      iconBg: 'bg-cyan-950/90 text-cyan-300 border border-cyan-800/60',
      desc: 'Decode byte sequences and SQL 0x hex literals to ASCII.',
      searchKeywords: 'hex hexadecimal byte stream bytes 0x ascii encode decode xxd'
    },
    {
      id: 'xor',
      category: 'CIPHERS & CRYPTOGRAPHY',
      name: 'Single-Byte XOR Decryptor',
      badge: 'XOR',
      badgeColor: 'text-rose-300 bg-rose-950/80 border-rose-800',
      icon: 'vpn_key',
      iconBg: 'bg-rose-950/90 text-rose-300 border border-rose-800/60',
      desc: 'Decrypt XOR masked strings against a numeric key (0-255).',
      searchKeywords: 'xor single byte key mask crypto decrypt cipher'
    },
    {
      id: 'url',
      category: 'ENCODING & SIGNALS',
      name: 'URL / Percent-Encoding',
      badge: '%20',
      badgeColor: 'text-blue-300 bg-blue-950/80 border-blue-800',
      icon: 'link',
      iconBg: 'bg-blue-950/90 text-blue-300 border border-blue-800/60',
      desc: 'Decode percent-encoded query parameters and escaped URLs.',
      searchKeywords: 'url percent encoding uri uri component decode encode web http'
    },
    {
      id: 'binary',
      category: 'ENCODING & SIGNALS',
      name: '8-Bit Binary Stream',
      badge: '0101',
      badgeColor: 'text-teal-300 bg-teal-950/80 border-teal-800',
      icon: 'pin',
      iconBg: 'bg-teal-950/90 text-teal-300 border border-teal-800/60',
      desc: 'Convert 8-bit binary bit sequences to ASCII characters.',
      searchKeywords: 'binary 8-bit bit bytes stream 01 ascii decode encode'
    },
    {
      id: 'morse',
      category: 'ENCODING & SIGNALS',
      name: 'Morse Code CW Pulse',
      badge: 'CW',
      badgeColor: 'text-green-300 bg-green-950/80 border-green-800',
      icon: 'graphic_eq',
      iconBg: 'bg-green-950/90 text-green-300 border border-green-800/60',
      desc: 'Translate international Morse code dots and dashes.',
      searchKeywords: 'morse code dots dashes radio audio telemetry translate'
    },
    {
      id: 'git',
      category: 'VERSION CONTROL',
      name: 'Git Commit Forensics',
      badge: 'GIT',
      badgeColor: 'text-indigo-300 bg-indigo-950/80 border-indigo-800',
      icon: 'source',
      iconBg: 'bg-indigo-950/90 text-indigo-300 border border-indigo-800/60',
      desc: 'Audit commit tree, deleted files, and diff history.',
      searchKeywords: 'git repository commit log show tree diff version control'
    }
  ];

  let isSidebarCollapsed = false;

  // Initialize UI with sleek cyber dark theme
  function initCyberTerminalUI() {
    if (document.getElementById('cyber-terminal-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'cyber-terminal-panel';
    panel.className = 'fixed bottom-0 left-0 right-0 z-[95] bg-[#0b0f19] text-slate-100 border-t border-slate-800 shadow-[0_-8px_35px_rgba(0,0,0,0.7)] flex flex-col font-sans text-xs transition-all duration-300 transform translate-y-full';
    panel.style.height = '430px';

    panel.innerHTML = `
      <!-- Window Title Bar (Sleek Cyber Dark) -->
      <div class="h-11 bg-[#0f172a] border-b border-slate-800 px-3 flex items-center justify-between select-none shrink-0 gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex items-center gap-1.5 mr-1.5 shrink-0">
            <span class="w-3 h-3 rounded-full bg-rose-500 hover:bg-rose-400 cursor-pointer shadow-xs transition-all" onclick="window.closeCyberTerminal()" title="Close Toolkit"></span>
            <span class="w-3 h-3 rounded-full bg-amber-500 hover:bg-amber-400 cursor-pointer shadow-xs transition-all" onclick="window.toggleTerminalMinimize()" title="Minimize to Corner Dock"></span>
            <span class="w-3 h-3 rounded-full bg-emerald-500 hover:bg-emerald-400 cursor-pointer shadow-xs transition-all" onclick="window.toggleTerminalMaximize()" title="Maximize / Restore Height"></span>
          </div>
          <span class="font-bold text-white flex items-center gap-1.5 text-xs tracking-wide">
            <span class="material-symbols-outlined text-base text-purple-400">home_repair_service</span>
            <span>FORENSIC TOOLS &amp; TERMINAL</span>
          </span>
          <span id="header-active-tool-badge" class="hidden sm:inline-block text-[10px] bg-purple-950/80 text-purple-300 px-2 py-0.5 rounded-full border border-purple-800 shrink-0 font-semibold font-mono">
            ACTIVE: BASH CLI
          </span>
          <!-- In-Window Docked Tray for Minimized Tools -->
          <div id="header-docked-tray" class="hidden items-center gap-1.5 overflow-x-auto py-0.5 px-2 max-w-[200px] md:max-w-xs lg:max-w-md bg-slate-900/90 rounded-lg border border-slate-800 shrink-0"></div>
        </div>

        <!-- Distinctly Separated Window Controls -->
        <div class="flex items-center gap-1.5 shrink-0">
          <!-- Separate Minimize Button -->
          <button onclick="window.toggleTerminalMinimize()" class="flex items-center gap-1 text-slate-300 hover:text-amber-300 px-2.5 py-1 rounded-md bg-slate-800/90 hover:bg-slate-700 border border-slate-700 shadow-2xs transition-all cursor-pointer text-xs font-semibold" title="Minimize to separate floating corner dock">
            <span class="material-symbols-outlined text-sm text-amber-400">minimize</span>
            <span class="text-[11px]">Minimize</span>
          </button>

          <!-- Separate Maximize Button -->
          <button onclick="window.toggleTerminalMaximize()" class="flex items-center gap-1 text-slate-300 hover:text-emerald-300 px-2.5 py-1 rounded-md bg-slate-800/90 hover:bg-slate-700 border border-slate-700 shadow-2xs transition-all cursor-pointer text-xs font-semibold" title="Maximize / Standard Height">
            <span class="material-symbols-outlined text-sm text-emerald-400" id="terminal-max-icon">fullscreen</span>
            <span class="hidden sm:inline text-[11px]" id="terminal-max-label">Maximize</span>
          </button>

          <!-- Close Button -->
          <button onclick="window.closeCyberTerminal()" class="text-slate-400 hover:text-rose-400 p-1 rounded-md hover:bg-rose-950/40 transition-all cursor-pointer ml-1" title="Close Toolkit">
            <span class="material-symbols-outlined text-base">close</span>
          </button>
        </div>
      </div>

      <!-- Main Body Container -->
      <div id="terminal-body-container" class="flex-1 flex min-h-0 overflow-hidden bg-[#0b0f19]">
        
        <!-- Left Sidebar: Categorized & Searchable Tools List (Dark Theme) -->
        <div id="tools-sidebar" class="w-64 sm:w-72 bg-[#0d1322] border-r border-slate-800 flex flex-col shrink-0 transition-all duration-200">
          
          <!-- Search Header & Sidebar Minimize Toggle -->
          <div class="p-2.5 border-b border-slate-800 bg-[#0f172a] space-y-1.5">
            <div class="flex items-center justify-between gap-1">
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">FORENSIC TOOLKIT</span>
              <div class="flex items-center gap-1.5">
                <span id="tool-search-count" class="text-[10px] text-purple-300 font-bold bg-purple-950/80 px-1.5 py-0.2 rounded border border-purple-800 font-mono">9 TOOLS</span>
                <button onclick="window.toggleToolsSidebar()" class="p-0.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors" title="Collapse tools list">
                  <span class="material-symbols-outlined text-sm">left_panel_close</span>
                </button>
              </div>
            </div>
            
            <div class="relative">
              <span class="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
              <input 
                type="text" 
                id="tool-search-input" 
                oninput="window.searchToolsList(this.value)" 
                placeholder="Search tools (hex, base64...)..." 
                class="w-full bg-[#070b14] border border-slate-800 rounded-lg pl-8 pr-7 py-1.5 text-xs text-slate-100 outline-none focus:border-purple-500 focus:bg-[#0b0f19] font-mono transition-all placeholder:text-slate-500 shadow-inner"
                autocomplete="off"
              >
              <button id="tool-search-clear-btn" onclick="window.clearToolSearch()" class="hidden absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-xs font-bold p-0.5" title="Clear search">✕</button>
            </div>
          </div>

          <!-- Categorized Tools List (Clean, Modern Dark Cards) -->
          <div id="tools-sidebar-list" class="flex-1 overflow-y-auto p-2 space-y-2.5 scrollbar-thin">
            ${CATEGORIES.map(cat => {
              const catTools = TOOLS_LIST.filter(t => t.category === cat);
              return `
                <div class="tool-category-group" data-category="${cat}">
                  <div class="px-2 py-0.5 text-[9px] font-bold text-slate-500 tracking-wider uppercase font-mono">${cat}</div>
                  <div class="space-y-1 mt-1">
                    ${catTools.map(tool => `
                      <div 
                        id="sidebar-item-${tool.id}" 
                        onclick="window.selectForensicTool('${tool.id}')"
                        class="tool-list-row group flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all ${tool.id === selectedToolId ? 'bg-slate-800/90 border-l-4 border-l-purple-500 border border-slate-700 shadow-sm text-white font-bold' : 'border border-transparent hover:bg-slate-800/60 hover:border-slate-700 text-slate-300 hover:text-white'}"
                        data-keywords="${tool.searchKeywords}"
                        title="${tool.desc}"
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <div class="w-6 h-6 rounded-md ${tool.iconBg} flex items-center justify-center shrink-0 shadow-2xs">
                            <span class="material-symbols-outlined text-sm leading-none">${tool.icon}</span>
                          </div>
                          <span class="text-xs truncate ${tool.id === selectedToolId ? 'text-white font-bold' : 'font-medium group-hover:text-white'}">${tool.name}</span>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                          <span id="sidebar-docked-tag-${tool.id}" class="hidden text-[8px] px-1.5 py-0.2 rounded font-mono font-bold bg-amber-950 text-amber-300 border border-amber-700">DOCKED</span>
                          <span class="text-[9px] px-1.5 py-0.2 rounded font-mono font-bold shrink-0 border ${tool.badgeColor}">${tool.badge}</span>
                          <button onclick="event.stopPropagation(); window.toggleToolDock('${tool.id}')" class="text-slate-500 hover:text-amber-300 p-0.5 rounded hover:bg-slate-750 transition-colors" title="Minimize / Dock this tool">
                            <span class="material-symbols-outlined text-xs">minimize</span>
                          </button>
                        </div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Bottom Hotkey Reference -->
          <div class="p-2 border-t border-slate-800 bg-[#0f172a] text-[10px] text-slate-400 flex items-center justify-between">
            <span>Toggle Hotkey:</span>
            <kbd class="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono shadow-2xs font-semibold">Ctrl + ~</kbd>
          </div>
        </div>

        <!-- Right Workspace: Selected Tool Execution View (Dark) -->
        <div class="flex-1 flex flex-col min-w-0 bg-[#0b0f19] overflow-hidden">
          
          <!-- Tool Header Bar -->
          <div class="h-10 bg-[#0f172a] border-b border-slate-800 px-3 flex items-center justify-between shrink-0 gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <button id="workspace-expand-sidebar-btn" onclick="window.toggleToolsSidebar()" class="hidden items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-purple-950 text-slate-200 hover:text-purple-300 rounded border border-slate-700 text-[11px] font-bold cursor-pointer transition-colors shadow-2xs shrink-0" title="Expand tools list">
                <span class="material-symbols-outlined text-sm text-purple-400">view_sidebar</span>
                <span>Tools List</span>
              </button>
              <div class="w-6 h-6 rounded-md bg-purple-950 text-purple-300 border border-purple-800/60 flex items-center justify-center shrink-0" id="active-tool-icon-box">
                <span id="active-tool-icon" class="material-symbols-outlined text-sm">terminal</span>
              </div>
              <span id="active-tool-title" class="font-bold text-white text-xs truncate">Interactive BASH CLI</span>
              <span id="active-tool-desc" class="hidden lg:inline text-[11px] text-slate-400 truncate max-w-md border-l border-slate-800 pl-2">Type commands manually into the command prompt</span>
            </div>

            <!-- Workspace Actions -->
            <div class="flex items-center gap-1.5 shrink-0 font-sans">
              <button onclick="window.toggleToolsSidebar()" class="hidden sm:flex items-center gap-1 text-slate-300 hover:text-white px-2 py-0.5 rounded bg-slate-800/90 hover:bg-slate-700 text-[11px] font-medium transition-colors cursor-pointer border border-slate-700" title="Toggle tools list sidebar">
                <span class="material-symbols-outlined text-xs">view_sidebar</span>
                <span id="sidebar-toggle-text">Focus Tool</span>
              </button>
              <button onclick="window.minimizeTool(selectedToolId)" class="flex items-center gap-1 text-amber-300 hover:text-amber-200 px-2.5 py-1 rounded-md bg-amber-950/70 hover:bg-amber-900/70 border border-amber-800/80 text-[11px] font-semibold transition-colors cursor-pointer shadow-2xs" title="Minimize active tool to the floating dock">
                <span class="material-symbols-outlined text-xs text-amber-400">minimize</span>
                <span>Minimize Tool</span>
              </button>
            </div>
          </div>

          <!-- Tool Content Area (Loads selected tool panel) -->
          <div id="active-tool-workspace" class="flex-1 flex flex-col min-h-0 overflow-hidden font-mono bg-[#070b14]">

            <!-- 1. BASH CLI TOOL -->
            <div id="tool-view-terminal" class="tool-view flex-1 flex flex-col min-h-0 p-3 overflow-hidden bg-[#0b0f19]">
              <div id="terminal-history" class="flex-1 overflow-y-auto space-y-1.5 pr-2 select-text font-mono text-[11px] sm:text-[12px] leading-relaxed break-words overflow-x-hidden text-slate-200">
                <div class="text-slate-400 border-b border-slate-800 pb-2 mb-2">
                  <div class="text-purple-400 font-bold break-words flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-sm">terminal</span>
                    <span>CASEFILE CYBER FORENSIC SANDBOX // BASH v5.2</span>
                  </div>
                  <div class="mt-1 break-words text-slate-400">Select any decoder from the sidebar list on the left, or type CLI commands here. Enter <span class="text-amber-400 font-bold font-mono">'help'</span> for docs (<span class="text-purple-400">git</span>, <span class="text-cyan-400">hex</span>, <span class="text-purple-400">base64</span>, <span class="text-amber-400">rot13</span>, <span class="text-blue-400">urldecode</span>, <span class="text-emerald-400">morse</span>, <span class="text-cyan-400">curl</span>).</div>
                </div>
              </div>

              <!-- Terminal Input Line -->
              <div class="flex items-center gap-2 pt-2 border-t border-slate-800 shrink-0 bg-[#0f172a]">
                <span class="text-purple-400 font-bold shrink-0 font-mono">operative@0xraven:~$</span>
                <input type="text" id="terminal-cli-input" class="flex-1 bg-[#070b14] border border-slate-800 rounded px-2 py-1 text-slate-100 outline-none font-mono text-xs caret-purple-400 focus:border-purple-500 focus:bg-[#0b0f19] transition-colors placeholder:text-slate-600" placeholder="Type command here (e.g. hex 4252..., base64 -d ..., rot13 ..., git log)..." autocomplete="off" spellcheck="false">
                <button onclick="window.handleTerminalSubmit()" class="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded text-[11px] font-bold cursor-pointer shrink-0 transition-colors shadow-xs">
                  RUN ↵
                </button>
              </div>
            </div>

            <!-- 2. HEXADECIMAL DECODER TOOL -->
            <div id="tool-view-hex" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3.5 bg-[#0b0f19]">
              <div class="bg-[#0f172a] p-4 rounded-xl border border-slate-800 shadow-md space-y-3">
                <span class="text-cyan-400 font-bold text-xs flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-sm">memory</span>
                  <span>HEXADECIMAL BYTE STREAM (HEX ➔ ASCII)</span>
                </span>
                <p class="text-[11px] text-slate-400 font-sans">Convert hex byte streams or SQL 0x literals (e.g. <code>42 52 4F 4B 45 4E</code> or <code>0x53514C...</code>) into plain readable ASCII.</p>
                <textarea id="tool-hex-in" class="w-full h-24 bg-[#070b14] border border-slate-800 rounded-lg p-3 text-slate-100 font-mono text-xs outline-none focus:border-cyan-500 focus:bg-[#0b0f19] transition-all shadow-inner placeholder:text-slate-600" placeholder="Enter hex pairs (e.g. 48 65 6C 6C 6F or 0x4E6F74)..."></textarea>
                <div class="flex gap-2 font-sans">
                  <button onclick="window.convertHexToAscii()" class="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-lg cursor-pointer transition-colors shadow-xs">CONVERT HEX ➔ ASCII</button>
                  <button onclick="window.convertAsciiToHex()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold rounded-lg cursor-pointer transition-colors shadow-2xs">ASCII ➔ HEX</button>
                </div>
                <div class="p-3 bg-[#070b14] rounded-lg border border-slate-800 text-cyan-300 font-mono text-xs font-bold min-h-[44px] select-all flex items-center justify-between">
                  <span id="tool-hex-out" class="break-all text-slate-300 font-mono">(Decoded ASCII plain text output will appear here)</span>
                  <button onclick="window.copyToolText('tool-hex-out')" class="text-[11px] text-cyan-400 hover:text-cyan-300 underline ml-2 shrink-0 font-sans font-semibold">Copy</button>
                </div>
              </div>
            </div>

            <!-- 3. BASE64 DECODER TOOL -->
            <div id="tool-view-base64" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3.5 bg-[#0b0f19]">
              <div class="bg-[#0f172a] p-4 rounded-xl border border-slate-800 shadow-md space-y-3">
                <span class="text-emerald-400 font-bold text-xs flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-sm">lock_open</span>
                  <span>BASE64 UTILITY DECODER / ENCODER</span>
                </span>
                <p class="text-[11px] text-slate-400 font-sans">Decode exfiltrated session cookies, authorization headers, or Base64 payloads (RFC 4648 with terminal = padding).</p>
                <textarea id="tool-b64-in" class="w-full h-20 bg-[#070b14] border border-slate-800 rounded-lg p-3 text-slate-100 font-mono text-xs outline-none focus:border-emerald-500 focus:bg-[#0b0f19] transition-all shadow-inner placeholder:text-slate-600" placeholder="Enter Base64 string to decode (e.g. VEhFX1JFUE9fV0FT...)..."></textarea>
                <div class="flex gap-2 font-sans">
                  <button onclick="window.convertBase64(false)" class="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg cursor-pointer transition-colors shadow-xs">DECODE BASE64</button>
                  <button onclick="window.convertBase64(true)" class="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold rounded-lg cursor-pointer transition-colors shadow-2xs">ENCODE BASE64</button>
                </div>
                <div class="p-3 bg-[#070b14] rounded-lg border border-slate-800 text-emerald-300 font-mono text-xs font-bold min-h-[44px] select-all flex items-center justify-between">
                  <span id="tool-b64-res" class="break-all text-slate-300 font-mono">(Decoded plain text will appear here)</span>
                  <button onclick="window.copyToolText('tool-b64-res')" class="text-[11px] text-emerald-400 hover:text-emerald-300 underline ml-2 shrink-0 font-sans font-semibold">Copy</button>
                </div>
              </div>
            </div>

            <!-- 4. ROT13 / CAESAR CIPHER TOOL -->
            <div id="tool-view-rot13" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3.5 bg-[#0b0f19]">
              <div class="bg-[#0f172a] p-4 rounded-xl border border-slate-800 shadow-md space-y-3">
                <span class="text-amber-400 font-bold text-xs flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-sm">sync</span>
                  <span>ROT13 / CAESAR SUBSTITUTION CIPHER</span>
                </span>
                <p class="text-[11px] text-slate-400 font-sans">Rotate alphabetical letters by 13 positions (or choose custom Caesar cipher rotation shift) to recover hidden messages.</p>
                <div class="flex gap-2">
                  <input type="text" id="tool-rot-in" class="flex-1 bg-[#070b14] border border-slate-800 rounded-lg p-3 text-slate-100 font-mono text-xs outline-none focus:border-amber-500 focus:bg-[#0b0f19] transition-all shadow-inner placeholder:text-slate-600" placeholder="Enter ciphertext to rotate (e.g. GUR_CNFFJBEQ...)...">
                  <select id="tool-rot-shift" class="bg-[#0f172a] border border-slate-700 rounded-lg px-3 text-xs text-slate-200 font-mono outline-none shadow-2xs">
                    <option value="13" selected>ROT13 (±13)</option>
                    <option value="1">ROT1 (+1)</option>
                    <option value="3">Caesar (+3)</option>
                    <option value="5">ROT5 (+5)</option>
                    <option value="7">ROT7 (+7)</option>
                  </select>
                </div>
                <button onclick="window.convertRot13()" class="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg cursor-pointer transition-colors shadow-xs font-sans">
                  ROTATE CHARACTERS &amp; DECIPHER
                </button>
                <div class="p-3 bg-[#070b14] rounded-lg border border-slate-800 text-amber-300 font-mono text-xs font-bold min-h-[44px] select-all flex items-center justify-between">
                  <span id="tool-rot-res" class="break-all text-slate-300 font-mono">(Deciphered text will appear here)</span>
                  <button onclick="window.copyToolText('tool-rot-res')" class="text-[11px] text-amber-400 hover:text-amber-300 underline ml-2 shrink-0 font-sans font-semibold">Copy</button>
                </div>
              </div>
            </div>

            <!-- 5. URL / PERCENT-ENCODING TOOL -->
            <div id="tool-view-url" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3.5 bg-[#0b0f19]">
              <div class="bg-[#0f172a] p-4 rounded-xl border border-slate-800 shadow-md space-y-3">
                <span class="text-blue-400 font-bold text-xs flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-sm">link</span>
                  <span>URL / PERCENT-ENCODING DECODER</span>
                </span>
                <p class="text-[11px] text-slate-400 font-sans">Decode percent-escaped URI components (e.g. <code>%41%55%54...</code>) and query string tokens into ASCII text.</p>
                <textarea id="tool-url-in" class="w-full h-20 bg-[#070b14] border border-slate-800 rounded-lg p-3 text-slate-100 font-mono text-xs outline-none focus:border-blue-500 focus:bg-[#0b0f19] transition-all shadow-inner placeholder:text-slate-600" placeholder="Enter percent-encoded string (e.g. %41%55%54%48%4F...)..."></textarea>
                <div class="flex gap-2 font-sans">
                  <button onclick="window.convertUrlPercent(false)" class="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-lg cursor-pointer transition-colors shadow-xs">DECODE URL PERCENT</button>
                  <button onclick="window.convertUrlPercent(true)" class="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold rounded-lg cursor-pointer transition-colors shadow-2xs">ENCODE URL</button>
                </div>
                <div class="p-3 bg-[#070b14] rounded-lg border border-slate-800 text-blue-300 font-mono text-xs font-bold min-h-[44px] select-all flex items-center justify-between">
                  <span id="tool-url-res" class="break-all text-slate-300 font-mono">(Decoded URL plain text output will appear here)</span>
                  <button onclick="window.copyToolText('tool-url-res')" class="text-[11px] text-blue-400 hover:text-blue-300 underline ml-2 shrink-0 font-sans font-semibold">Copy</button>
                </div>
              </div>
            </div>

            <!-- 6. MORSE CODE TRANSLATOR TOOL -->
            <div id="tool-view-morse" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3.5 bg-[#0b0f19]">
              <div class="bg-[#0f172a] p-4 rounded-xl border border-slate-800 shadow-md space-y-3">
                <span class="text-green-400 font-bold text-xs flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-sm">graphic_eq</span>
                  <span>MORSE CODE TELEMETRY TRANSLATOR</span>
                </span>
                <p class="text-[11px] text-slate-400 font-sans">Translate international Morse code CW pulses (. and - separated by spaces) into readable letters.</p>
                <textarea id="tool-morse-in" class="w-full h-20 bg-[#070b14] border border-slate-800 rounded-lg p-3 text-slate-100 font-mono text-xs outline-none focus:border-green-500 focus:bg-[#0b0f19] transition-all shadow-inner placeholder:text-slate-600" placeholder="Enter Morse code (e.g. -- --- .-. ... .   .. ...   .- .-.. .. ...- .)..."></textarea>
                <div class="flex gap-2 font-sans">
                  <button onclick="window.convertMorse(false)" class="flex-1 py-2 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg cursor-pointer transition-colors shadow-xs">DECODE MORSE</button>
                  <button onclick="window.convertMorse(true)" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold rounded-lg cursor-pointer transition-colors shadow-2xs">TEXT ➔ MORSE</button>
                </div>
                <div class="p-3 bg-[#070b14] rounded-lg border border-slate-800 text-green-300 font-mono text-xs font-bold min-h-[44px] select-all flex items-center justify-between">
                  <span id="tool-morse-res" class="break-all text-slate-300 font-mono">(Decoded Morse output will appear here)</span>
                  <button onclick="window.copyToolText('tool-morse-res')" class="text-[11px] text-green-400 hover:text-green-300 underline ml-2 shrink-0 font-sans font-semibold">Copy</button>
                </div>
              </div>
            </div>

            <!-- 7. BINARY STREAM TOOL -->
            <div id="tool-view-binary" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3.5 bg-[#0b0f19]">
              <div class="bg-[#0f172a] p-4 rounded-xl border border-slate-800 shadow-md space-y-3">
                <span class="text-teal-400 font-bold text-xs flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-sm">binary</span>
                  <span>8-BIT BINARY STREAM DECODER</span>
                </span>
                <p class="text-[11px] text-slate-400 font-sans">Translate raw 8-bit binary numbers (e.g. <code>01000001 01010101</code>) into ASCII characters or vice versa.</p>
                <textarea id="tool-bin-in" class="w-full h-20 bg-[#070b14] border border-slate-800 rounded-lg p-3 text-slate-100 font-mono text-xs outline-none focus:border-teal-500 focus:bg-[#0b0f19] transition-all shadow-inner placeholder:text-slate-600" placeholder="Enter binary bytes (e.g. 01001110 01101111 01110100)..."></textarea>
                <div class="flex gap-2 font-sans">
                  <button onclick="window.convertBinary(false)" class="flex-1 py-2 bg-teal-600 hover:bg-teal-500 text-white font-bold rounded-lg cursor-pointer transition-colors shadow-xs">BINARY ➔ ASCII</button>
                  <button onclick="window.convertBinary(true)" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold rounded-lg cursor-pointer transition-colors shadow-2xs">ASCII ➔ BINARY</button>
                </div>
                <div class="p-3 bg-[#070b14] rounded-lg border border-slate-800 text-teal-300 font-mono text-xs font-bold min-h-[44px] select-all flex items-center justify-between">
                  <span id="tool-bin-res" class="break-all text-slate-300 font-mono">(Decoded binary plain text will appear here)</span>
                  <button onclick="window.copyToolText('tool-bin-res')" class="text-[11px] text-teal-400 hover:text-teal-300 underline ml-2 shrink-0 font-sans font-semibold">Copy</button>
                </div>
              </div>
            </div>

            <!-- 8. SINGLE-BYTE XOR TOOL -->
            <div id="tool-view-xor" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3.5 bg-[#0b0f19]">
              <div class="bg-[#0f172a] p-4 rounded-xl border border-slate-800 shadow-md space-y-3">
                <span class="text-rose-400 font-bold text-xs flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-sm">vpn_key</span>
                  <span>SINGLE-BYTE XOR STREAM DECRYPTOR</span>
                </span>
                <p class="text-[11px] text-slate-400 font-sans">Apply a single-byte XOR key (numeric 0-255) to unmask encrypted byte sequences.</p>
                <div class="flex gap-2">
                  <input type="text" id="tool-xor-in" class="flex-1 bg-[#070b14] border border-slate-800 rounded-lg p-3 text-slate-100 font-mono text-xs outline-none focus:border-rose-500 focus:bg-[#0b0f19] transition-all shadow-inner placeholder:text-slate-600" placeholder="Enter text or ciphertext to XOR...">
                  <input type="number" id="tool-xor-key" min="0" max="255" value="42" class="w-20 bg-[#0f172a] border border-slate-700 rounded-lg p-3 text-xs text-slate-100 font-mono outline-none text-center shadow-2xs" title="XOR Key byte (0-255)">
                </div>
                <button onclick="window.convertXor()" class="w-full py-2 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg cursor-pointer transition-colors shadow-xs font-sans">
                  APPLY XOR KEY
                </button>
                <div class="p-3 bg-[#070b14] rounded-lg border border-slate-800 text-rose-300 font-mono text-xs font-bold min-h-[44px] select-all flex items-center justify-between">
                  <span id="tool-xor-res" class="break-all text-slate-300 font-mono">(XOR stream result will appear here)</span>
                  <button onclick="window.copyToolText('tool-xor-res')" class="text-[11px] text-rose-400 hover:text-rose-300 underline ml-2 shrink-0 font-sans font-semibold">Copy</button>
                </div>
              </div>
            </div>

            <!-- 9. GIT COMMIT FORENSICS TOOL -->
            <div id="tool-view-git" class="tool-view hidden flex-1 overflow-y-auto p-4 space-y-3 bg-[#0b0f19]">
              <div class="flex items-center justify-between border-b border-slate-800 pb-2">
                <div class="text-indigo-400 font-bold flex items-center gap-2">
                  <span class="material-symbols-outlined text-base">source</span>
                  <span>REPOSITORY: r4ven-sec / operation-midnight (ARCHIVED)</span>
                </div>
                <span class="text-slate-400 text-[11px] font-sans">3 COMMITS IN HISTORY</span>
              </div>
              <div class="space-y-2.5">
                ${GIT_REPO.commits.map(c => `
                  <div class="p-3.5 bg-[#0f172a] rounded-xl border border-slate-800 shadow-md space-y-2">
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-2">
                        <span class="px-2 py-0.5 rounded bg-indigo-950/80 text-indigo-300 font-bold border border-indigo-800 font-mono text-[11px]">${c.hash}</span>
                        <span class="font-bold text-white">${c.message}</span>
                      </div>
                      <span class="text-[11px] text-slate-400 font-sans">${c.date}</span>
                    </div>
                    <div class="text-[11px] text-slate-400 font-sans">Author: <span class="font-mono text-slate-200 font-semibold">${c.author}</span></div>
                    <details class="text-[11px] font-sans">
                      <summary class="text-purple-400 cursor-pointer hover:underline font-bold">Inspect Git Diff</summary>
                      <pre class="mt-2 p-2.5 bg-[#070b14] rounded border border-slate-800 text-slate-300 overflow-x-auto text-[11px] font-mono leading-relaxed">${c.diff.replace(/</g, '&lt;')}</pre>
                    </details>
                  </div>
                `).join('')}
              </div>
            </div>

          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Create separate floating multi-tool minimized dock widget in dark theme
    if (!document.getElementById('cyber-minimized-dock')) {
      const dock = document.createElement('div');
      dock.id = 'cyber-minimized-dock';
      dock.className = 'hidden fixed bottom-5 right-6 z-[98] bg-[#0f172a]/95 backdrop-blur-md border border-slate-700 shadow-[0_10px_35px_rgba(0,0,0,0.7)] rounded-2xl p-2 items-center gap-2 max-w-[92vw] overflow-x-auto select-none transition-all duration-200';
      document.body.appendChild(dock);
    }

    // Bind Enter key on CLI input
    const cliInput = document.getElementById('terminal-cli-input');
    if (cliInput) {
      cliInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          window.handleTerminalSubmit();
        } else if (e.key === 'ArrowUp') {
          if (commandHistory.length > 0 && historyIndex > 0) {
            historyIndex--;
            cliInput.value = commandHistory[historyIndex];
          }
        } else if (e.key === 'ArrowDown') {
          if (historyIndex < commandHistory.length - 1) {
            historyIndex++;
            cliInput.value = commandHistory[historyIndex];
          } else {
            historyIndex = commandHistory.length;
            cliInput.value = '';
          }
        }
      });
    }

    // Global keyboard shortcuts: Ctrl+` or Alt+T
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey && e.key === '`') || (e.altKey && (e.key === 't' || e.key === 'T'))) {
        window.toggleCyberTerminal();
      }
    });
  }

  // Toggle tools list sidebar (List minimize)
  window.toggleToolsSidebar = () => {
    const sidebar = document.getElementById('tools-sidebar');
    const expandBtn = document.getElementById('workspace-expand-sidebar-btn');
    const toggleText = document.getElementById('sidebar-toggle-text');
    if (!sidebar) return;

    isSidebarCollapsed = !isSidebarCollapsed;
    if (isSidebarCollapsed) {
      sidebar.classList.add('hidden');
      if (expandBtn) {
        expandBtn.classList.remove('hidden');
        expandBtn.classList.add('flex');
      }
      if (toggleText) toggleText.textContent = 'Show List';
    } else {
      sidebar.classList.remove('hidden');
      if (expandBtn) {
        expandBtn.classList.add('hidden');
        expandBtn.classList.remove('flex');
      }
      if (toggleText) toggleText.textContent = 'Focus Tool';
    }
    if (window.Sound) window.Sound.play('click');
  };

  // Clear tool search query
  window.clearToolSearch = () => {
    const input = document.getElementById('tool-search-input');
    if (input) {
      input.value = '';
      window.searchToolsList('');
      input.focus();
    }
  };

  // Real-time search/filter for left sidebar tools
  window.searchToolsList = (query) => {
    const q = (query || '').toLowerCase().trim();
    const clearBtn = document.getElementById('tool-search-clear-btn');
    if (clearBtn) {
      clearBtn.style.display = q ? 'block' : 'none';
    }

    let visibleCount = 0;
    TOOLS_LIST.forEach(tool => {
      const el = document.getElementById('sidebar-item-' + tool.id);
      if (!el) return;
      if (!q) {
        el.style.display = 'flex';
        visibleCount++;
      } else {
        const matchesName = tool.name.toLowerCase().includes(q);
        const matchesBadge = tool.badge.toLowerCase().includes(q);
        const matchesDesc = tool.desc.toLowerCase().includes(q);
        const matchesKeywords = (tool.searchKeywords || '').toLowerCase().includes(q);
        if (matchesName || matchesBadge || matchesDesc || matchesKeywords) {
          el.style.display = 'flex';
          visibleCount++;
        } else {
          el.style.display = 'none';
        }
      }
    });

    // Toggle category headers based on whether any children are visible
    document.querySelectorAll('.tool-category-group').forEach(group => {
      const rows = group.querySelectorAll('.tool-list-row');
      let anyVisible = false;
      rows.forEach(r => {
        if (r.style.display !== 'none') anyVisible = true;
      });
      group.style.display = anyVisible ? 'block' : 'none';
    });

    const countBadge = document.getElementById('tool-search-count');
    if (countBadge) {
      countBadge.textContent = q ? `${visibleCount} FOUND` : `${TOOLS_LIST.length} TOOLS`;
    }
  };

  // Render multi-tool dock and in-window tray
  window.renderMinimizedDock = () => {
    const dock = document.getElementById('cyber-minimized-dock');
    const headerTray = document.getElementById('header-docked-tray');
    if (!dock) return;

    // Update sidebar docked tags
    TOOLS_LIST.forEach(tool => {
      const tag = document.getElementById(`sidebar-docked-tag-${tool.id}`);
      if (tag) {
        if (minimizedToolIds.has(tool.id)) {
          tag.classList.remove('hidden');
          tag.classList.add('inline-flex');
        } else {
          tag.classList.add('hidden');
          tag.classList.remove('inline-flex');
        }
      }
    });

    const dockedTools = Array.from(minimizedToolIds).map(id => TOOLS_LIST.find(t => t.id === id)).filter(Boolean);

    if (dockedTools.length === 0) {
      dock.classList.add('hidden');
      dock.classList.remove('flex');
      if (headerTray) {
        headerTray.classList.add('hidden');
        headerTray.classList.remove('flex');
        headerTray.innerHTML = '';
      }
      return;
    }

    // Render In-Header Tray if panel is open
    if (headerTray) {
      headerTray.classList.remove('hidden');
      headerTray.classList.add('flex');
      headerTray.innerHTML = `
        <span class="text-[9px] text-amber-400 font-bold font-mono shrink-0">DOCKED (${dockedTools.length}):</span>
        ${dockedTools.map(t => `
          <div onclick="window.restoreTool('${t.id}')" class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-slate-200 hover:text-white border border-slate-700 cursor-pointer transition-colors shrink-0" title="Click to restore ${t.name}">
            <span class="material-symbols-outlined text-xs text-amber-400">${t.icon}</span>
            <span class="truncate max-w-[80px] font-mono">${t.badge}</span>
            <button onclick="event.stopPropagation(); window.closeMinimizedTool('${t.id}')" class="text-slate-400 hover:text-rose-400 ml-0.5" title="Remove from dock">✕</button>
          </div>
        `).join('')}
      `;
    }

    // Render Floating Multi-Tool Dock Bar
    dock.innerHTML = `
      <div class="flex items-center gap-1.5 pl-2 pr-1 shrink-0 font-mono text-[11px] font-bold text-slate-300">
        <span class="relative flex h-2 w-2">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        </span>
        <span class="text-amber-400 font-bold font-mono">${dockedTools.length} DOCKED</span>
      </div>

      <div class="flex items-center gap-1.5 overflow-x-auto max-w-[65vw] scrollbar-thin py-0.5">
        ${dockedTools.map(tool => `
          <div 
            onclick="window.restoreTool('${tool.id}')"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 border border-slate-700 hover:border-purple-500 transition-all cursor-pointer group shadow-xs shrink-0 select-none"
            title="Click to restore ${tool.name}"
          >
            <div class="w-5 h-5 rounded-md ${tool.iconBg} flex items-center justify-center shrink-0">
              <span class="material-symbols-outlined text-xs">${tool.icon}</span>
            </div>
            <span class="text-xs font-bold text-white group-hover:text-purple-300 whitespace-nowrap">${tool.name}</span>
            <span class="text-[9px] px-1.5 py-0.2 rounded font-mono font-bold ${tool.badgeColor}">${tool.badge}</span>
            <button 
              onclick="event.stopPropagation(); window.closeMinimizedTool('${tool.id}')" 
              class="text-slate-400 hover:text-rose-400 p-0.5 rounded hover:bg-rose-950/40 ml-1 transition-colors" 
              title="Close ${tool.name}"
            >
              <span class="material-symbols-outlined text-xs">close</span>
            </button>
          </div>
        `).join('')}
      </div>

      <div class="flex items-center gap-1 shrink-0 pl-1 border-l border-slate-800">
        ${dockedTools.length > 1 ? `
          <button onclick="window.restoreAllTools()" class="text-xs bg-purple-900/70 hover:bg-purple-600 text-purple-200 hover:text-white px-2.5 py-1.5 rounded-xl font-bold flex items-center gap-1 transition-all border border-purple-700 cursor-pointer shrink-0 whitespace-nowrap shadow-xs">
            <span class="material-symbols-outlined text-xs">open_in_full</span>
            <span class="hidden sm:inline">Restore All</span>
          </button>
        ` : `
          <button onclick="window.restoreTool('${dockedTools[0].id}')" class="text-xs bg-purple-900/70 hover:bg-purple-600 text-purple-200 hover:text-white px-2.5 py-1.5 rounded-xl font-bold flex items-center gap-1 transition-all border border-purple-700 cursor-pointer shrink-0 whitespace-nowrap shadow-xs">
            <span class="material-symbols-outlined text-xs">open_in_full</span>
            <span>Restore</span>
          </button>
        `}
        <button onclick="window.closeAllMinimizedTools()" class="text-slate-400 hover:text-rose-400 p-1.5 rounded-xl hover:bg-rose-950/40 transition-all cursor-pointer shrink-0" title="Close all docked tools">
          <span class="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
    `;

    // Only show floating dock when main panel is hidden or minimized
    const panel = document.getElementById('cyber-terminal-panel');
    const isPanelHidden = !panel || panel.classList.contains('translate-y-full') || !terminalOpen || isMinimized;
    if (isPanelHidden) {
      dock.classList.remove('hidden');
      dock.classList.add('flex');
    } else {
      dock.classList.add('hidden');
      dock.classList.remove('flex');
    }
  };

  // Tool Selection Action
  window.selectForensicTool = (toolId) => {
    selectedToolId = toolId;
    const targetTool = TOOLS_LIST.find(t => t.id === toolId) || TOOLS_LIST[0];

    // If selected tool was docked, activating it removes it from dock
    if (minimizedToolIds.has(toolId)) {
      minimizedToolIds.delete(toolId);
      window.renderMinimizedDock();
    }

    // Update sidebar row highlight (Refined Dark Theme styling)
    TOOLS_LIST.forEach(t => {
      const row = document.getElementById('sidebar-item-' + t.id);
      if (row) {
        const titleSpan = row.querySelector('.text-xs');
        if (t.id === toolId) {
          row.className = 'tool-list-row group flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all bg-slate-800/90 border-l-4 border-l-purple-500 border border-slate-700 shadow-sm text-white font-bold';
          if (titleSpan) titleSpan.className = 'text-xs truncate text-white font-bold';
        } else {
          row.className = 'tool-list-row group flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all border border-transparent hover:bg-slate-800/60 hover:border-slate-700 text-slate-300 hover:text-white';
          if (titleSpan) titleSpan.className = 'text-xs truncate font-medium group-hover:text-white';
        }
      }

      // Hide/show tool workspaces
      const view = document.getElementById('tool-view-' + t.id);
      if (view) {
        if (t.id === toolId) {
          view.classList.remove('hidden');
        } else {
          view.classList.add('hidden');
        }
      }
    });

    // Update workspace header bar
    const titleEl = document.getElementById('active-tool-title');
    const iconEl = document.getElementById('active-tool-icon');
    const iconBox = document.getElementById('active-tool-icon-box');
    const descEl = document.getElementById('active-tool-desc');
    const badgeEl = document.getElementById('header-active-tool-badge');

    if (titleEl) titleEl.textContent = targetTool.name;
    if (iconEl) iconEl.textContent = targetTool.icon;
    if (iconBox) iconBox.className = `w-6 h-6 rounded-md ${targetTool.iconBg} flex items-center justify-center shrink-0`;
    if (descEl) descEl.textContent = targetTool.desc;
    if (badgeEl) badgeEl.textContent = `ACTIVE: ${targetTool.name.toUpperCase()}`;

    // Restore if minimized
    if (isMinimized) {
      window.restoreCyberTerminal();
    }

    // Auto-focus input if applicable
    setTimeout(() => {
      if (toolId === 'terminal') {
        document.getElementById('terminal-cli-input')?.focus();
      } else if (toolId === 'hex') {
        document.getElementById('tool-hex-in')?.focus();
      } else if (toolId === 'base64') {
        document.getElementById('tool-b64-in')?.focus();
      } else if (toolId === 'rot13') {
        document.getElementById('tool-rot-in')?.focus();
      } else if (toolId === 'url') {
        document.getElementById('tool-url-in')?.focus();
      } else if (toolId === 'morse') {
        document.getElementById('tool-morse-in')?.focus();
      } else if (toolId === 'binary') {
        document.getElementById('tool-bin-in')?.focus();
      } else if (toolId === 'xor') {
        document.getElementById('tool-xor-in')?.focus();
      }
    }, 100);

    if (window.Sound) window.Sound.play('click');
  };

  // Minimize a specific tool (can minimize any number of tools)
  window.minimizeTool = (toolId = selectedToolId) => {
    initCyberTerminalUI();
    minimizedToolIds.add(toolId);
    const panel = document.getElementById('cyber-terminal-panel');
    if (panel) panel.classList.add('translate-y-full');
    isMinimized = true;
    terminalOpen = false;
    window.renderMinimizedDock();
    const tool = TOOLS_LIST.find(t => t.id === toolId);
    if (window.toast) {
      window.toast('Tool Minimized', `${tool ? tool.name : 'Tool'} added to dock (${minimizedToolIds.size} docked).`, 'info', 2000);
    }
    if (window.Sound) window.Sound.play('click');
  };

  // Toggle dock status of a tool from sidebar
  window.toggleToolDock = (toolId) => {
    initCyberTerminalUI();
    const tool = TOOLS_LIST.find(t => t.id === toolId);
    if (minimizedToolIds.has(toolId)) {
      minimizedToolIds.delete(toolId);
      if (window.toast) window.toast('Undocked', `${tool ? tool.name : 'Tool'} removed from dock.`, 'info', 1800);
    } else {
      minimizedToolIds.add(toolId);
      if (window.toast) window.toast('Docked', `${tool ? tool.name : 'Tool'} minimized to dock.`, 'info', 1800);
    }
    window.renderMinimizedDock();
    if (window.Sound) window.Sound.play('click');
  };

  // Restore a specific tool from the dock
  window.restoreTool = (toolId) => {
    initCyberTerminalUI();
    minimizedToolIds.delete(toolId);
    isMinimized = false;
    terminalOpen = true;
    const panel = document.getElementById('cyber-terminal-panel');
    if (panel) {
      panel.classList.remove('translate-y-full');
      panel.style.height = isMaximized ? '90vh' : '430px';
    }
    window.selectForensicTool(toolId);
    window.renderMinimizedDock();
    if (window.Sound) window.Sound.play('click');
  };

  // Restore all docked tools
  window.restoreAllTools = () => {
    initCyberTerminalUI();
    const list = Array.from(minimizedToolIds);
    minimizedToolIds.clear();
    isMinimized = false;
    terminalOpen = true;
    const panel = document.getElementById('cyber-terminal-panel');
    if (panel) {
      panel.classList.remove('translate-y-full');
      panel.style.height = isMaximized ? '90vh' : '430px';
    }
    window.selectForensicTool(list[0] || selectedToolId);
    window.renderMinimizedDock();
    if (window.Sound) window.Sound.play('click');
  };

  // Close / undock a specific tool
  window.closeMinimizedTool = (toolId) => {
    minimizedToolIds.delete(toolId);
    window.renderMinimizedDock();
    if (window.Sound) window.Sound.play('click');
  };

  // Close all docked tools
  window.closeAllMinimizedTools = () => {
    minimizedToolIds.clear();
    window.renderMinimizedDock();
    if (window.Sound) window.Sound.play('click');
  };

  // Toggle open/close window
  window.toggleCyberTerminal = () => {
    initCyberTerminalUI();
    const panel = document.getElementById('cyber-terminal-panel');
    if (!panel) return;

    if (isMinimized || panel.classList.contains('translate-y-full')) {
      window.restoreCyberTerminal();
      return;
    }

    terminalOpen = !terminalOpen;
    if (terminalOpen) {
      panel.classList.remove('translate-y-full');
      isMinimized = false;
      if (window.Sound) window.Sound.play('click');
    } else {
      panel.classList.add('translate-y-full');
    }
    window.renderMinimizedDock();
  };

  // Close completely (from X button)
  window.closeCyberTerminal = () => {
    const panel = document.getElementById('cyber-terminal-panel');
    terminalOpen = false;
    isMinimized = false;
    if (panel) panel.classList.add('translate-y-full');
    window.renderMinimizedDock();
    if (window.Sound) window.Sound.play('click');
  };

  // Minimize window (separates into floating corner dock widget)
  window.toggleTerminalMinimize = () => {
    const panel = document.getElementById('cyber-terminal-panel');
    if (!panel) return;

    isMinimized = !isMinimized;
    if (isMinimized) {
      minimizedToolIds.add(selectedToolId);
      panel.classList.add('translate-y-full');
      terminalOpen = false;
      window.renderMinimizedDock();
      const curTool = TOOLS_LIST.find(t => t.id === selectedToolId) || TOOLS_LIST[0];
      if (window.toast) {
        window.toast('Tool Minimized', `${curTool.name} docked (${minimizedToolIds.size} in dock).`, 'info', 2200);
      }
    } else {
      window.restoreCyberTerminal();
    }
    if (window.Sound) window.Sound.play('click');
  };

  // Restore window from dock
  window.restoreCyberTerminal = () => {
    const panel = document.getElementById('cyber-terminal-panel');
    isMinimized = false;
    terminalOpen = true;
    if (panel) {
      panel.classList.remove('translate-y-full');
      panel.style.height = isMaximized ? '90vh' : '430px';
    }
    if (minimizedToolIds.has(selectedToolId)) {
      minimizedToolIds.delete(selectedToolId);
    }
    window.renderMinimizedDock();
    if (window.Sound) window.Sound.play('click');
  };

  // Maximize / expand height window
  window.toggleTerminalMaximize = () => {
    const panel = document.getElementById('cyber-terminal-panel');
    const maxIcon = document.getElementById('terminal-max-icon');
    const maxLabel = document.getElementById('terminal-max-label');
    if (!panel) return;

    if (isMinimized) {
      window.restoreCyberTerminal();
    }

    isMaximized = !isMaximized;
    if (isMaximized) {
      panel.style.height = '90vh';
      if (maxIcon) maxIcon.textContent = 'fullscreen_exit';
      if (maxLabel) maxLabel.textContent = 'Standard';
    } else {
      panel.style.height = '430px';
      if (maxIcon) maxIcon.textContent = 'fullscreen';
      if (maxLabel) maxLabel.textContent = 'Maximize';
    }
  };

  // Backwards compatible aliases
  window.toggleTerminalExpand = window.toggleTerminalMaximize;
  window.openCyberTerminalWithTool = (toolId) => {
    initCyberTerminalUI();
    if (!terminalOpen) window.toggleCyberTerminal();
    window.selectForensicTool(toolId || 'terminal');
  };
  window.runTerminalCommand = () => window.openCyberTerminalWithTool('terminal');
  window.switchTerminalTab = (tab) => window.selectForensicTool(tab === 'decoders' ? 'hex' : tab);

  // Main CLI Parser (Dark theme styled output)
  window.handleTerminalSubmit = () => {
    const input = document.getElementById('terminal-cli-input');
    const history = document.getElementById('terminal-history');
    if (!input || !history) return;

    const raw = input.value.trim();
    if (!raw) return;

    commandHistory.push(raw);
    historyIndex = commandHistory.length;

    // Append user command
    const userLine = document.createElement('div');
    userLine.className = 'flex items-center gap-1.5 text-slate-200 font-bold';
    userLine.innerHTML = `<span class="text-purple-400 font-mono">operative@0xraven:~$</span> <span>${escapeHtml(raw)}</span>`;
    history.appendChild(userLine);

    input.value = '';

    const outputEl = document.createElement('div');
    outputEl.className = 'pl-2 text-slate-300 font-mono text-[11px] mb-2';

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    const argStr = args.join(' ').trim();

    if (cmd === 'clear') {
      history.innerHTML = '';
      return;
    } else if (cmd === 'help') {
      outputEl.innerHTML = `
        <div class="text-purple-400 font-bold mb-1">CYBER FORENSIC SANDBOX CLI DOCUMENTATION:</div>
        <div class="text-slate-400 mb-2">Select tools from the left sidebar or use CLI commands directly:</div>
        <table class="w-full text-[11px] space-y-1">
          <tr><td class="text-purple-400 font-bold w-36">git log [-p]</td><td>Audit commit history and patch diffs in repository</td></tr>
          <tr><td class="text-purple-400 font-bold">git show &lt;hash&gt;</td><td>Inspect specific commit or scrubbed files</td></tr>
          <tr><td class="text-cyan-400 font-bold">hex &lt;bytes...&gt;</td><td>Decode hexadecimal bytes into readable ASCII</td></tr>
          <tr><td class="text-purple-400 font-bold">base64 -d &lt;str&gt;</td><td>Decode a Base64-encoded string into plain text</td></tr>
          <tr><td class="text-amber-400 font-bold">rot13 &lt;str&gt;</td><td>Rotate characters by 13 positions (Caesar cipher)</td></tr>
          <tr><td class="text-blue-400 font-bold">urldecode &lt;str&gt;</td><td>Decode URL / percent-encoded string</td></tr>
          <tr><td class="text-teal-400 font-bold">binary &lt;bits&gt;</td><td>Decode 8-bit binary stream (01000001...)</td></tr>
          <tr><td class="text-emerald-400 font-bold">morse &lt;dots...&gt;</td><td>Decode Morse code CW telemetry into text</td></tr>
          <tr><td class="text-cyan-400 font-bold">curl &lt;url&gt;</td><td>Probe target web applications and examine headers</td></tr>
          <tr><td class="text-slate-500 font-bold">clear</td><td>Clear terminal history buffer</td></tr>
        </table>
      `;
    } else if (cmd === 'git') {
      const sub = (args[0] || '').toLowerCase();
      if (!sub || sub === 'log') {
        const isPatch = args.includes('-p') || args.includes('-u');
        outputEl.innerHTML = `
          ${GIT_REPO.commits.map(c => `
            <div class="mb-2 p-2.5 bg-[#0f172a] rounded border border-slate-800">
              <span class="text-amber-400 font-bold">commit ${c.fullHash}</span> ${c.hash === '3c9b4e1' ? '<span class="text-purple-400 font-bold">(HEAD -> main)</span>' : ''}<br/>
              <span class="text-slate-400">Author: ${c.author}</span><br/>
              <span class="text-slate-500">Date:   ${c.date}</span><br/>
              <div class="my-1 text-white font-bold">${c.message}</div>
              ${isPatch ? `<pre class="text-purple-300 bg-[#070b14] p-2 rounded text-[10px] mt-1 border border-slate-800 leading-relaxed overflow-x-auto">${escapeHtml(c.diff)}</pre>` : ''}
            </div>
          `).join('')}
          ${!isPatch ? `<div class="text-amber-400 text-[10px] mt-1">[HINT] Inspect patch diffs with: <span class="text-purple-400 font-bold">git log -p</span> or <span class="text-purple-400 font-bold">git show &lt;hash&gt;</span>!</div>` : ''}
        `;
      } else if (sub === 'show') {
        const targetHash = args[1] || '';
        const found = GIT_REPO.commits.find(c => c.hash === targetHash || c.fullHash.startsWith(targetHash));
        if (!found) {
          outputEl.innerHTML = `<div class="text-rose-400 font-bold">fatal: commit '${escapeHtml(targetHash)}' not found in repository. Try 'git log' to see commits.</div>`;
        } else {
          outputEl.innerHTML = `
            <div class="p-2.5 bg-[#0f172a] rounded border border-slate-800">
              <div class="text-amber-400 font-bold">commit ${found.fullHash}</div>
              <div class="text-slate-400">Author: ${found.author}</div>
              <div class="text-slate-500">Date:   ${found.date}</div>
              <div class="my-1 text-white font-bold">${found.message}</div>
              <pre class="text-purple-300 bg-[#070b14] p-2 rounded text-[10px] mt-1 border border-slate-800 overflow-x-auto leading-relaxed">${escapeHtml(found.diff)}</pre>
            </div>
          `;
        }
      } else if (sub === 'status') {
        outputEl.innerHTML = `<div class="text-emerald-400 font-bold">On branch main. Working tree clean. (Tip: deleted files remain in git history).</div>`;
      } else {
        outputEl.innerHTML = `<div class="text-rose-400">git: '${escapeHtml(sub)}' is not supported. Try 'git log' or 'git show'.</div>`;
      }
    } else if (cmd === 'hex' || (cmd === 'xxd' && args.includes('-r'))) {
      const hexInput = (cmd === 'hex' ? argStr : args.filter(a => a !== '-r' && a !== '-p').join(' ')).trim();
      if (!hexInput) {
        outputEl.innerHTML = `<div class="text-amber-400 font-bold">[HINT] Usage: hex &lt;pairs_of_hex_bytes&gt;. Example: hex 4E 6F 74...</div>`;
      } else {
        const decoded = hexToAscii(hexInput);
        outputEl.innerHTML = `
          <div class="text-cyan-400 font-bold">[HEX DECODE RESULT]</div>
          <div class="text-slate-200 text-xs my-1">Decoded Text: <span class="text-cyan-300 font-bold bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800 font-mono">"${escapeHtml(decoded)}"</span></div>
        `;
      }
    } else if (cmd === 'base64' || cmd === 'b64') {
      const isDecode = args.includes('-d') || cmd === 'b64';
      const cleanArgs = args.filter(a => a !== '-d');
      const str = cleanArgs.join('').trim();
      if (!str) {
        outputEl.innerHTML = `<div class="text-amber-400 font-bold">[HINT] Usage: base64 -d &lt;encoded_string&gt;</div>`;
      } else {
        try {
          const res = isDecode ? atob(str.replace(/-/g, '+').replace(/_/g, '/')) : btoa(str);
          outputEl.innerHTML = `
            <div class="text-purple-400 font-bold">[BASE64 ${isDecode ? 'DECODE' : 'ENCODE'} RESULT]</div>
            <div class="text-slate-200 text-xs my-1"><span class="text-purple-300 font-bold bg-purple-950/80 px-2 py-0.5 rounded border border-purple-800 font-mono">${escapeHtml(res)}</span></div>
          `;
        } catch (e) {
          outputEl.innerHTML = `<div class="text-rose-400 font-bold">base64: invalid input string format.</div>`;
        }
      }
    } else if (cmd === 'rot13') {
      if (!argStr) {
        outputEl.innerHTML = `<div class="text-amber-400 font-bold">[HINT] Usage: rot13 &lt;ciphertext&gt;</div>`;
      } else {
        outputEl.innerHTML = `
          <div class="text-amber-400 font-bold">[ROT13 TRANSLATION RESULT]</div>
          <div class="text-slate-200 text-xs my-1"><span class="text-amber-300 font-bold bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800 font-mono">${escapeHtml(rot13(argStr))}</span></div>
        `;
      }
    } else if (cmd === 'urldecode' || cmd === 'url') {
      if (!argStr) {
        outputEl.innerHTML = `<div class="text-blue-400 font-bold">[HINT] Usage: urldecode &lt;percent_encoded_string&gt;</div>`;
      } else {
        try {
          outputEl.innerHTML = `
            <div class="text-blue-400 font-bold">[URL PERCENT DECODE RESULT]</div>
            <div class="text-slate-200 text-xs my-1"><span class="text-blue-300 font-bold bg-blue-950/80 px-2 py-0.5 rounded border border-blue-800 font-mono">${escapeHtml(decodeUrlPercent(argStr))}</span></div>
          `;
        } catch (e) {
          outputEl.innerHTML = `<div class="text-rose-400 font-bold">urldecode: invalid percent encoding format.</div>`;
        }
      }
    } else if (cmd === 'morse') {
      const morseInput = raw.replace(/^\s*morse\s+/i, '').trim();
      if (!morseInput) {
        outputEl.innerHTML = `<div class="text-amber-400 font-bold">[HINT] Usage: morse &lt;dots_and_dashes&gt;</div>`;
      } else {
        const decoded = decodeMorse(morseInput);
        outputEl.innerHTML = `
          <div class="text-green-400 font-bold">[MORSE TRANSLATION RESULT]</div>
          <div class="text-slate-200 text-xs my-1"><span class="text-green-300 font-bold bg-green-950/80 px-2 py-0.5 rounded border border-green-800 font-mono">${escapeHtml(decoded)}</span></div>
        `;
      }
    } else if (cmd === 'binary') {
      if (!argStr) {
        outputEl.innerHTML = `<div class="text-amber-400 font-bold">[HINT] Usage: binary &lt;01000001...&gt;</div>`;
      } else {
        outputEl.innerHTML = `
          <div class="text-teal-400 font-bold">[BINARY DECODE RESULT]</div>
          <div class="text-slate-200 text-xs my-1"><span class="text-teal-300 font-bold bg-teal-950/80 px-2 py-0.5 rounded border border-teal-800 font-mono">${escapeHtml(binaryToAscii(argStr))}</span></div>
        `;
      }
    } else if (cmd === 'curl') {
      const url = args[0] || '';
      if (!url) {
        outputEl.innerHTML = `<div class="text-amber-400 font-bold">[HINT] curl requires a target URL. Example: curl /api/profile?user_id=1</div>`;
      } else {
        outputEl.innerHTML = `
          <div class="text-cyan-400 font-bold">HTTP/1.1 200 OK</div>
          <div class="text-slate-400">Server: 0xRAVEN-Target-Gateway</div>
          <pre class="text-slate-300 bg-[#070b14] p-2 rounded text-[10px] mt-1 border border-slate-800 font-mono">Target host response recorded. Open target application in simulated browser.</pre>
        `;
      }
    } else {
      outputEl.innerHTML = `
        <div class="text-rose-400 font-mono font-bold">bash: command not found: '${escapeHtml(cmd)}'</div>
        <div class="text-amber-400 mt-1 font-bold">[HINT] Looking for forensic decoders?</div>
        <div class="text-slate-400 text-[11px] space-y-0.5 mt-0.5 font-mono">
          <div>&bull; Click any decoder in the sidebar list on the left!</div>
          <div>&bull; Or run: <span class="text-cyan-400 font-bold">hex</span>, <span class="text-purple-400 font-bold">base64 -d</span>, <span class="text-amber-400 font-bold">rot13</span>, <span class="text-blue-400 font-bold">urldecode</span>, <span class="text-emerald-400 font-bold">morse</span>.</div>
        </div>
      `;
    }

    history.appendChild(outputEl);
    history.scrollTop = history.scrollHeight;
  };

  // GUI Tool Converters
  window.convertHexToAscii = () => {
    const input = document.getElementById('tool-hex-in');
    const output = document.getElementById('tool-hex-out');
    if (!input || !output) return;
    const res = hexToAscii(input.value.trim());
    output.textContent = res || '(No valid hex bytes detected. Enter hex pairs like 4E 6F 74...)';
    if (window.Sound) window.Sound.play('click');
  };

  window.convertAsciiToHex = () => {
    const input = document.getElementById('tool-hex-in');
    const output = document.getElementById('tool-hex-out');
    if (!input || !output) return;
    const res = asciiToHex(input.value.trim());
    output.textContent = res || '(Enter text to convert to hex)';
  };

  window.convertBase64 = (isEncode) => {
    const input = document.getElementById('tool-b64-in');
    const res = document.getElementById('tool-b64-res');
    if (!input || !res) return;
    const val = input.value.trim();
    if (!val) {
      res.textContent = 'Please enter a Base64 string to decode';
      return;
    }
    try {
      res.textContent = isEncode ? btoa(val) : atob(val.replace(/-/g, '+').replace(/_/g, '/'));
    } catch (e) {
      res.textContent = 'Error: Invalid Base64 input string';
    }
  };

  window.convertRot13 = () => {
    const input = document.getElementById('tool-rot-in');
    const shiftEl = document.getElementById('tool-rot-shift');
    const res = document.getElementById('tool-rot-res');
    if (!input || !res) return;
    const val = input.value.trim();
    if (!val) {
      res.textContent = 'Please enter text to rotate';
      return;
    }
    const shift = parseInt(shiftEl?.value || '13', 10);
    res.textContent = rot13(val, shift);
  };

  window.convertUrlPercent = (isEncode) => {
    const input = document.getElementById('tool-url-in');
    const res = document.getElementById('tool-url-res');
    if (!input || !res) return;
    const val = input.value.trim();
    if (!val) {
      res.textContent = 'Please enter a URL/percent-encoded string';
      return;
    }
    try {
      res.textContent = isEncode ? encodeUrlPercent(val) : decodeUrlPercent(val);
    } catch (e) {
      res.textContent = 'Error: Invalid percent-encoded sequence';
    }
  };

  window.convertMorse = (isEncode) => {
    const input = document.getElementById('tool-morse-in');
    const res = document.getElementById('tool-morse-res');
    if (!input || !res) return;
    const val = input.value.trim();
    if (!val) {
      res.textContent = 'Please enter Morse code dots and dashes';
      return;
    }
    res.textContent = isEncode ? encodeMorse(val) : decodeMorse(val);
  };

  window.convertBinary = (isEncode) => {
    const input = document.getElementById('tool-bin-in');
    const res = document.getElementById('tool-bin-res');
    if (!input || !res) return;
    const val = input.value.trim();
    if (!val) {
      res.textContent = 'Please enter 8-bit binary bytes (e.g. 01000001...)';
      return;
    }
    res.textContent = isEncode ? asciiToBinary(val) : binaryToAscii(val);
  };

  window.convertXor = () => {
    const input = document.getElementById('tool-xor-in');
    const keyEl = document.getElementById('tool-xor-key');
    const res = document.getElementById('tool-xor-res');
    if (!input || !res) return;
    const val = input.value.trim();
    const key = parseInt(keyEl?.value || '42', 10) % 256;
    if (!val) {
      res.textContent = 'Please enter text to apply XOR key';
      return;
    }
    let out = '';
    for (let i = 0; i < val.length; i++) {
      out += String.fromCharCode(val.charCodeAt(i) ^ key);
    }
    res.textContent = out;
  };

  window.copyToolText = (elemId) => {
    const el = document.getElementById(elemId);
    if (!el) return;
    const text = el.textContent || el.value || '';
    if (text && !text.startsWith('(') && !text.startsWith('Error') && !text.startsWith('Please')) {
      navigator.clipboard?.writeText(text);
      if (window.toast) window.toast('Copied', 'Decoded token copied to clipboard', 'success', 2000);
    }
  };

  window.copyToolOutput = window.copyToolText;

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCyberTerminalUI);
  } else {
    initCyberTerminalUI();
  }

})();
