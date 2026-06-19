#!/usr/bin/env python3
"""
Safety Workflows - Web GIS Orthomosaic Tiler
===========================================
This script takes a high-resolution drone orthomosaic GeoTIFF, verifies its projection,
reprojects it to EPSG:3857 (Web Mercator) if necessary, and tiles it directly into
an OSM/Google Maps-compatible XYZ folder structure (z/x/y.png).

Requirements:
- GDAL Python bindings (osgeo.gdal)
- rasterio (optional, used to verify CRS)
"""

import argparse
import os
import sys
import shutil
import subprocess
from osgeo import gdal, osr

# Configure GDAL to raise exceptions on errors
gdal.UseExceptions()

def check_and_reproject_to_3857(input_path, output_dir, source_srs=None):
    """
    Checks the coordinate system of the input raster. If it is not EPSG:3857,
    reprojects it to EPSG:3857. If the file has no projection metadata,
    we override it using the provided source_srs or fall back to EPSG:4326.
    """
    print(f"[*] Opening raster: {input_path}")
    dataset = gdal.Open(input_path)
    projection = dataset.GetProjection()
    
    is_mercator = False
    epsg_code = None
    
    if not projection:
        # No projection in file
        if not source_srs:
            source_srs = "EPSG:4326"
            print(f"[!] Warning: Input file has no projection metadata (not georeferenced).")
            print(f"    We will assume standard drone GPS coordinates ({source_srs}).")
            print(f"    If this is incorrect, override it with: --source-srs EPSG:XXXX")
        else:
            print(f"[!] Input file has no projection metadata. Using user-specified source SRS: {source_srs}")
    else:
        # File has projection metadata
        try:
            srs = osr.SpatialReference(wkt=projection)
            try:
                srs.AutoIdentifyEPSG()
                epsg_code = srs.GetAuthorityCode(None)
            except Exception:
                pass  # AutoIdentifyEPSG frequently fails on non-standard metadata
                
            if epsg_code == '3857':
                is_mercator = True
        except Exception as e:
            print(f"[!] Warning: Could not parse spatial reference: {e}")

        # Fallback string matching
        if not is_mercator:
            proj_upper = projection.upper()
            if '3857' in proj_upper or 'WEB_MERCATOR' in proj_upper or 'PSEUDO_MERCATOR' in proj_upper or 'POPULAR VISUALISATION' in proj_upper:
                is_mercator = True
                
        if is_mercator and not source_srs:
            print("[+] Coordinate system verified as EPSG:3857 (Web Mercator). No reprojection needed.")
            return input_path

    # We need to reproject
    reprojected_tif = os.path.join(output_dir, "temp_reprojected_ortho.tif")
    print("[*] Reprojecting GeoTIFF to EPSG:3857 (Web Mercator)...")
    
    try:
        # Define warp options
        warp_kwargs = {
            "dstSRS": "EPSG:3857",
            "resampleAlg": gdal.GRA_Bilinear,
            "creationOptions": ["COMPRESS=LZW", "TILED=YES"]
        }
        # If we have an override source SRS or the file was unprojected
        if not projection or source_srs:
            warp_kwargs["srcSRS"] = source_srs or epsg_code
            
        gdal.Warp(reprojected_tif, dataset, **warp_kwargs)
        print(f"[+] Reprojected file saved temporarily to: {reprojected_tif}")
        return reprojected_tif
    except Exception as e:
        print(f"[!] Warning: Reprojection failed ({e}). Attempting to tile original file...")
        return input_path

def run_gdal2tiles(input_tif, output_tiles_dir, zoom, source_srs=None):
    """
    Locates and executes gdal2tiles to slice the TIFF into standard XYZ structure (z/x/y.png).
    Tries multiple fallback execution paths for maximum compatibility.
    """
    print(f"[*] Starting tiling process into: {output_tiles_dir}")
    s_srs_arg = ["--s_srs", source_srs] if source_srs else []
    
    # 1. Try importing osgeo_utils directly (GDAL 3.x native API)
    try:
        from osgeo_utils import gdal2tiles
        print("[*] Found osgeo_utils.gdal2tiles. Slicing tiles in-process...")
        opts_dict = {"zoom": zoom, "nb_processes": 4, "xyz": True, "quiet": False}
        if source_srs:
            opts_dict["s_srs"] = source_srs
        options = gdal2tiles.Options(**opts_dict)
        gdal2tiles.GDAL2Tiles(input_tif, output_tiles_dir, options).process()
        print("[+] Tiles created successfully using osgeo_utils.")
        return
    except (ImportError, AttributeError, Exception) as e:
        print(f"[!] Direct Python API tiling failed or not available ({e}). Trying CLI wrapper...")

    # 2. Try looking for gdal2tiles in system PATH
    cmd = shutil.which("gdal2tiles") or shutil.which("gdal2tiles.py")
    if cmd:
        print(f"[*] Executing CLI tool: {cmd}")
        args = [cmd, "--xyz", f"--zoom={zoom}", "--processes=4"] + s_srs_arg + [input_tif, output_tiles_dir]
        subprocess.run(args, check=True)
        print("[+] Tiles created successfully using CLI tool.")
        return

    # 3. Try finding it inside Python's environment scripts (common on Windows/Conda)
    script_paths = [
        os.path.join(sys.prefix, "Scripts", "gdal2tiles.py"),
        os.path.join(sys.prefix, "Scripts", "gdal2tiles"),
        os.path.join(sys.prefix, "bin", "gdal2tiles.py"),
        os.path.join(sys.prefix, "bin", "gdal2tiles"),
    ]
    for path in script_paths:
        if os.path.exists(path):
            print(f"[*] Executing Python script wrapper: {path}")
            args = [sys.executable, path, "--xyz", f"--zoom={zoom}", "--processes=4"] + s_srs_arg + [input_tif, output_tiles_dir]
            subprocess.run(args, check=True)
            print("[+] Tiles created successfully using local script.")
            return

    # 4. Try executing as a module call
    try:
        print("[*] Attempting execution as 'python -m osgeo_utils.gdal2tiles'...")
        args = [sys.executable, "-m", "osgeo_utils.gdal2tiles", "--xyz", f"--zoom={zoom}", "--processes=4"] + s_srs_arg + [input_tif, output_tiles_dir]
        subprocess.run(args, check=True)
        print("[+] Tiles created successfully using python module execution.")
        return
    except subprocess.CalledProcessError as e:
        print(f"[!] Module execution failed: {e}")

    # If all fail, throw error
    raise RuntimeError(
        "Could not execute gdal2tiles. Ensure GDAL Python tools are installed.\n"
        "Try running: pip install gdal2tiles"
    )

def main():
    parser = argparse.ArgumentParser(
        description="Reprojects and tiles an orthomosaic GeoTIFF into standard Leaflet XYZ format without QGIS."
    )
    parser.add_argument("--input-ortho", required=True, help="Path to the input orthomosaic GeoTIFF")
    parser.add_argument("--output-dir", required=True, help="Directory to save the generated XYZ tiles")
    parser.add_argument("--zoom", default="12-21", help="Zoom levels to generate, e.g. 12-21 (default)")
    parser.add_argument("--source-srs", default=None, help="Force coordinate reference system for the input raster (e.g. EPSG:4326)")
    
    args = parser.parse_args()
    
    # Resolve absolute paths
    input_ortho = os.path.abspath(args.input_ortho)
    output_dir = os.path.abspath(args.output_dir)
    
    if not os.path.exists(input_ortho):
        print(f"[-] Error: Input file not found: {input_ortho}")
        sys.exit(1)
        
    os.makedirs(output_dir, exist_ok=True)
    
    temp_reprojected = None
    try:
        # Step 1: Ensure EPSG:3857 (overriding using source_srs if provided or needed)
        process_tif = check_and_reproject_to_3857(input_ortho, output_dir, args.source_srs)
        if process_tif != input_ortho:
            temp_reprojected = process_tif
            
        # Step 2: Slice into XYZ tiles
        # If we reprojected, the output already has EPSG:3857.
        # Otherwise, if we skipped reprojection, we pass source_srs if the user provided it.
        s_srs_to_pass = args.source_srs if process_tif == input_ortho else None
        run_gdal2tiles(process_tif, output_dir, args.zoom, s_srs_to_pass)
        
        print(f"\n[+] SUCCESS: Orthomosaic tiles exported to: {output_dir}")
        
    except Exception as e:
        print(f"\n[-] Critical error: {e}")
        sys.exit(1)
        
    finally:
        # Clean up temporary reprojected file if it was created
        if temp_reprojected and os.path.exists(temp_reprojected):
            print("[*] Cleaning up temporary reprojected TIFF...")
            try:
                os.remove(temp_reprojected)
            except Exception as e:
                print(f"[!] Warning: Could not delete temporary file: {e}")

if __name__ == "__main__":
    main()
