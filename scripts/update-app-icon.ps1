param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class XrayIconResources {
  delegate bool EnumName(IntPtr module,IntPtr type,IntPtr name,IntPtr param);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr LoadLibraryEx(string file,IntPtr reserved,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool EnumResourceNames(IntPtr module,IntPtr type,EnumName callback,IntPtr param);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr BeginUpdateResource(string file,bool deleteExisting);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool UpdateResource(IntPtr update,IntPtr type,IntPtr name,ushort language,byte[] bytes,uint length);
  [DllImport("kernel32.dll",SetLastError=true)]static extern bool EndUpdateResource(IntPtr update,bool discard);
  [DllImport("shell32.dll")]static extern void SHChangeNotify(uint eventId,uint flags,IntPtr first,IntPtr second);
  static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
  public static void Replace(string executable,string icon){
    var groups=new List<string>();var module=LoadLibraryEx(executable,IntPtr.Zero,2);
    if(module==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    try{EnumResourceNames(module,new IntPtr(14),(m,t,n,p)=>{groups.Add(n.ToInt64()<=65535?"#"+n.ToInt64():Marshal.PtrToStringUni(n));return true;},IntPtr.Zero);}finally{FreeLibrary(module);}
    if(groups.Count==0)groups.Add("#1");
    var bytes=File.ReadAllBytes(icon);var reader=new BinaryReader(new MemoryStream(bytes));
    reader.ReadUInt16();if(reader.ReadUInt16()!=1)throw new InvalidDataException("Not an icon file");var count=reader.ReadUInt16();
    var groupStream=new MemoryStream();var writer=new BinaryWriter(groupStream);writer.Write((ushort)0);writer.Write((ushort)1);writer.Write(count);
    var images=new List<byte[]>();
    for(int i=0;i<count;i++){
      var directory=reader.ReadBytes(12);var offset=reader.ReadUInt32();var length=BitConverter.ToUInt32(directory,8);var image=new byte[length];Buffer.BlockCopy(bytes,(int)offset,image,0,(int)length);images.Add(image);writer.Write(directory);writer.Write((ushort)(500+i));
    }
    var update=BeginUpdateResource(executable,false);if(update==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());bool success=false;
    try{
      foreach(ushort language in new ushort[]{0,1033}){
        for(int i=0;i<images.Count;i++)Check(UpdateResource(update,new IntPtr(3),new IntPtr(500+i),language,images[i],(uint)images[i].Length));
        foreach(var group in groups){IntPtr name=group.StartsWith("#")?new IntPtr(int.Parse(group.Substring(1))):Marshal.StringToHGlobalUni(group);
          try{Check(UpdateResource(update,new IntPtr(14),name,language,groupStream.ToArray(),(uint)groupStream.Length));}finally{if(!group.StartsWith("#"))Marshal.FreeHGlobal(name);}}
      }
      success=true;
    }finally{Check(EndUpdateResource(update,!success));reader.Dispose();writer.Dispose();groupStream.Dispose();}
    SHChangeNotify(0x08000000,0,IntPtr.Zero,IntPtr.Zero);
  }
}
'@
$resolvedExecutable=(Resolve-Path -LiteralPath $Executable).Path
$resolvedIcon=(Resolve-Path -LiteralPath $Icon).Path
[XrayIconResources]::Replace($resolvedExecutable,$resolvedIcon)
Write-Output 'Updated executable icon resources and notified Windows shell.'
