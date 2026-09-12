// Copyright 2026 Aster contributors. Apache-2.0.
// Serialized cases are adapted from Tesseract's Apache-2.0 upstream tests
// retained in the original security patches under source-provenance.
// This build-only executable links the exact shared libraries shipped at runtime.
#include "network.h"
#include "serialis.h"
#include "classify.h"
#include "genericvector.h"
#include "intproto.h"
#include "unicharset.h"
#include <tiffio.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>

using namespace tesseract;
struct Bytes {
  std::vector<char> data;
  void u8(uint32_t v) { data.push_back(static_cast<char>(v)); }
  void u32(uint32_t v) { for (int i=0;i<4;i++) u8(v >> (8*i)); }
  void real(double d) {
    uint64_t bits; std::memcpy(&bits, &d, sizeof(bits));
    u32(static_cast<uint32_t>(bits)); u32(static_cast<uint32_t>(bits >> 32));
  }
  void header(NetworkType type, int ni, int no) {
    u8(type); u8(0); u8(0); u32(0); u32(ni); u32(no); u32(0); u32(0);
  }
  void matrix(int rows, int columns) {
    u8(128); u32(rows); u32(columns); real(0);
    for (int i=0;i<rows*columns;i++) real(0);
  }
};
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void loaded(Bytes &bytes, bool expected) {
  TFile fp; require(fp.Open(bytes.data.data(), bytes.data.size()), "fixture open failed");
  Network* net = Network::CreateFromFile(&fp);
  bool accepted = net != nullptr; delete net;
  require(accepted == expected, "network deserialization regression failed");
}
void dimensions() {
  for (auto type : {NT_CONVOLVE, NT_RECONFIG}) {
    Bytes invalid; invalid.header(type, 2, 1); invalid.u32(65535); invalid.u32(65535);
    loaded(invalid, false);
    Bytes valid; valid.header(type, 2, 1); valid.u32(1); valid.u32(1); loaded(valid, true);
  }
  for (auto shape : {std::vector<int>{1,1,3,5}, {1,1,1,5}, {1,2,2,2}}) {
    Bytes b; b.header(NT_SOFTMAX, shape[0], shape[1]); b.matrix(shape[2], shape[3]);
    loaded(b, shape[2] == shape[1] && shape[3] == shape[0] + 1);
  }
  // Inconsistent na_, gate row count, gate column count, output count; valid control.
  for (int scenario=0;scenario<5;scenario++) {
    Bytes b; b.header(NT_LSTM, 1, scenario == 3 ? 4 : 5); b.u32(scenario == 0 ? 2 : 6);
    for (int gate=0;gate<4;gate++)
      b.matrix(scenario == 1 && gate == 1 ? 9 : 5, scenario == 2 && gate == 1 ? 9 : 7);
    loaded(b, scenario == 4);
  }
}
void normproto() {
  char temp[] = "/tmp/aster-normproto-XXXXXX";
  require(mkdtemp(temp) != nullptr, "temporary directory failed");
  std::string path = std::string(temp) + "/eng.unicharset";
  FILE* file = fopen(path.c_str(), "w"); require(file != nullptr, "fixture file failed");
  const char* chars = "2\nNULL 1 0,255,0,255,0,0,0,0,0,0 Latin 2 0 2\na 1 0,255,0,255,0,0,0,0,0,0 Latin 2 0 2\n";
  require(fwrite(chars,1,strlen(chars),file) == strlen(chars), "fixture write failed"); fclose(file);
  Classify classifier; require(classifier.unicharset.load_from_file(path.c_str()), "unicharset failed");
  unlink(path.c_str()); rmdir(temp);
  for (const auto& line : {std::string(99,'A')+"\n", std::string(60,'A')+" 0\n", std::string("a 0\n")}) {
    std::string data="5\n"; for(int i=0;i<5;i++) data+="e e 0 1\n"; data+=line;
    TFile fp; require(fp.Open(data.data(),data.size()), "normproto fixture failed");
    classifier.NormProtos = classifier.ReadNormProtos(&fp);
    require(classifier.NormProtos != nullptr, "normproto parse failed"); classifier.FreeNormProtos();
  }
}
void generic_vectors() {
  // The callback loop must never run with a used count outside its allocation.
  // Include negative counts, the allocation cap, and a valid two-element vector.
  for (auto shape : {std::vector<int>{4,8,8}, {-1,-1,0}, {4,-1,0},
                     {50000001,0,0}, {4,2,2}}) {
    Bytes b; b.u32(shape[0]); b.u32(shape[1]);
    for (int i=0;i<shape[2];i++) b.u32(i);
    TFile fp; require(fp.Open(b.data.data(),b.data.size()),"vector fixture open failed");
    GenericVector<int> values; int callbacks=0;
    bool accepted=values.read(&fp,[&callbacks](TFile* file,int* value) {
      callbacks++; return file->DeSerialize(value);
    });
    bool expected=shape[1]==2;
    require(accepted==expected,"GenericVector count validation failed");
    if (expected) require(values.size()==2 && values[0]==0 && values[1]==1 && callbacks==2,
                          "valid GenericVector contents changed");
    else require(callbacks==0,"invalid GenericVector entered callback loop");
  }
}
void unicharsets() {
  const char* inputs[]={"3\nA 0 Latin\nA 0 Latin\nB 0 Latin\n", "0\n", "-1\n",
                        "3\nA 0 Latin\nB 0 Latin\nC 0 Latin\n"};
  for (int i=0;i<4;i++) {
    TFile fp; require(fp.Open(inputs[i],strlen(inputs[i])),"unicharset fixture open failed");
    UNICHARSET chars;
    require(chars.load_from_file(&fp,false)==(i==3),"unicharset count/duplicate regression failed");
    if (i==3) require(chars.size()==3 && strcmp(chars.id_to_unichar(1),"B")==0,
                       "valid unicharset contents changed");
  }
}
void intprotos() {
  // Exercise the deserializer directly so missing traineddata components cannot
  // make negative initialization tests pass for an unrelated reason.
  for (int scenario=0;scenario<5;scenario++) {
    uint32_t unichars=scenario==3 ? MAX_NUM_CLASSES+1 : 1;
    uint32_t pruners=scenario==0 ? MAX_NUM_CLASS_PRUNERS+1 : 0;
    uint32_t classes=scenario==1 ? MAX_NUM_CLASSES+1 : (scenario==2 || scenario==4 ? 1 : 0);
    Bytes b; b.u32(unichars); b.u32(static_cast<uint32_t>(scenario==3 ? -1 : -5));
    b.u32(pruners); b.u32(classes);
    if (classes==1) {
      b.u8(0); b.u8(0); // uint16 NumProtos
      b.u8(scenario==2 ? MAX_NUM_PROTO_SETS+1 : 0);
      b.u8(scenario==4 ? MAX_NUM_CONFIGS+1 : 0);
    }
    TFile fp; require(fp.Open(b.data.data(),b.data.size()),"intproto fixture open failed");
    Classify classifier; auto* parsed=classifier.ReadIntTemplates(&fp);
    bool rejected=parsed==nullptr; delete parsed;
    require(rejected,"unsafe intproto count was accepted");
  }
  // Complete valid version3 component: no classes/pruners and no font tables.
  Bytes b; b.u32(0); b.u32(static_cast<uint32_t>(-3)); b.u32(0); b.u32(0);
  TFile fp; require(fp.Open(b.data.data(),b.data.size()),"valid intproto fixture open failed");
  Classify classifier; auto* parsed=classifier.ReadIntTemplates(&fp);
  require(parsed!=nullptr,"valid intproto component was rejected");
  bool correct=parsed->NumClasses==0 && parsed->NumClassPruners==0; delete parsed;
  require(correct,"valid intproto counts changed");
}
void tiff() {
  // TIFFGetMaxCompressionRatio is part of the CVE-2026-36849 fix. Exercise
  // codec dispatch in the actual linked library, including a known-safe control.
  char temp[]="/tmp/aster-tiff-XXXXXX"; int fd=mkstemp(temp); require(fd>=0,"TIFF temp failed"); close(fd);
  TIFF* tif=TIFFOpen(temp,"w"); require(tif!=nullptr,"TIFF open failed"); unlink(temp);
  TIFFSetField(tif,TIFFTAG_IMAGEWIDTH,8); TIFFSetField(tif,TIFFTAG_IMAGELENGTH,8);
  TIFFSetField(tif,TIFFTAG_BITSPERSAMPLE,8); TIFFSetField(tif,TIFFTAG_SAMPLESPERPIXEL,1);
  TIFFSetField(tif,TIFFTAG_ROWSPERSTRIP,8); TIFFSetField(tif,TIFFTAG_PLANARCONFIG,PLANARCONFIG_CONTIG);
  TIFFSetField(tif,TIFFTAG_PHOTOMETRIC,PHOTOMETRIC_MINISBLACK);
  TIFFSetField(tif,TIFFTAG_COMPRESSION,COMPRESSION_NONE);
  require(TIFFGetMaxCompressionRatio(tif)==1,"uncompressed TIFF ratio incorrect");
  TIFFSetField(tif,TIFFTAG_COMPRESSION,COMPRESSION_PACKBITS);
  require(TIFFGetMaxCompressionRatio(tif)>1,"bounded TIFF compression ratio missing"); TIFFClose(tif);

  // A two-byte PackBits strip claims a 256 MiB decoded row via SamplesPerPixel.
  // Request only one decoded byte: the historical decoder could accept it, but
  // the CVE guard must reject the implausible full strip before allocation.
  char crafted[]="/tmp/aster-tiff-ratio-XXXXXX"; fd=mkstemp(crafted); require(fd>=0,"TIFF temp failed"); close(fd);
  tif=TIFFOpen(crafted,"w"); require(tif!=nullptr,"TIFF fixture open failed");
  TIFFSetField(tif,TIFFTAG_IMAGEWIDTH,4096); TIFFSetField(tif,TIFFTAG_IMAGELENGTH,1);
  TIFFSetField(tif,TIFFTAG_BITSPERSAMPLE,8); TIFFSetField(tif,TIFFTAG_SAMPLESPERPIXEL,65535);
  TIFFSetField(tif,TIFFTAG_ROWSPERSTRIP,1); TIFFSetField(tif,TIFFTAG_PLANARCONFIG,PLANARCONFIG_CONTIG);
  TIFFSetField(tif,TIFFTAG_PHOTOMETRIC,PHOTOMETRIC_MINISBLACK);
  TIFFSetField(tif,TIFFTAG_COMPRESSION,COMPRESSION_PACKBITS);
  unsigned char encoded[2]={0,42}; require(TIFFWriteRawStrip(tif,0,encoded,2)==2,"TIFF raw fixture failed");
  TIFFClose(tif); tif=TIFFOpen(crafted,"r"); require(tif!=nullptr,"crafted TIFF open failed"); unlink(crafted);
  unsigned char output=0; require(TIFFReadEncodedStrip(tif,0,&output,1)==-1,"implausible TIFF strip accepted");
  TIFFClose(tif);
}
int main() {
  try { dimensions(); normproto(); tiff(); generic_vectors(); unicharsets(); intprotos(); }
  catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
  std::cout << "{\"schemaVersion\":1,\"networkCases\":12,\"normprotoCases\":3,\"tiffCodecCases\":3,"
               "\"genericVectorCases\":5,\"unicharsetCases\":4,\"intprotoCases\":6,\"passed\":true}\n";
}
