#!/usr/bin/env python3
"""
Safety Workflows - Web GIS Slope Overlay Tiler
===========================================
This script takes a high-resolution Digital Surface Model (DSM) GeoTIFF containing
elevation data, calculates the slope using GDAL, reprojects it to EPSG:3857,
classifies and colorizes it block-by-block (fully memory-safe/OOM-proof),
and tiles the resulting transparent colored overlay into an XYZ directory (z/x/y.png).

Requirements:
- GDAL Python bindings (osgeo.gdal)
- rasterio
- numpy
"""

import argparse
import os
import sys
import shutil
import subprocess
import numpy as np
import rasterio
from osgeo import gdal, osr

# Configure GDAL to raise exceptions on errors
gdal.UseExceptions()

# Define slope classification thresholds (degrees)
SLOPE_THRESHOLDS = {
    "Flat (0-3°)": (0.0, 3.0),
    "Gentle (3-7°)": (3.0, 7.0),
    "Moderate (7-12°)": (7.0, 12.0),
    "Steep (12-20°)": (12.0, 20.0),
    "Very Steep (>20°)": (20.0, 90.0)
}

# Assign colors (RGBA with 40% transparency = 102 alpha value)
COLOR_MAP = {
    "Flat (0-3°)": (0, 255, 0, 102),        # Green
    "Gentle (3-7°)": (144, 238, 144, 102),  # Light Green
    "Moderate (7-12°)": (255, 255, 0, 102),  # Yellow
    "Steep (12-20°)": (255, 165, 0, 102),   # Orange
    "Very Steep (>20°)": (255, 0, 0, 102)    # Red
}

def check_and_reproject_to_3857(input_path, output_dir, file_label="raw slope", source_srs=None):
    """
    Checks if the coordinate system is EPSG:3857. If not, reprojects it.
    Using NearestNeighbor to preserve clean, un-interpolated elevation/slope values.
    If the file has no projection metadata, we override it using the provided source_srs or fall back to EPSG:4326.
    """
    print(f"[*] Verifying coordinate system of {file_label}...")
    dataset = gdal.Open(input_path)
    projection = dataset.GetProjection()
    
    is_mercator = False
    epsg_code = None
    
    if not projection:
        # No projection in file
        if not source_srs:
            source_srs = "EPSG:4326"
            print(f"[!] Warning: Input {file_label} has no projection metadata (not georeferenced).")
            print(f"    We will assume standard drone GPS coordinates ({source_srs}).")
            print(f"    If this is incorrect, override it with: --source-srs EPSG:XXXX")
        else:
            print(f"[!] Input {file_label} has no projection metadata. Using user-specified source SRS: {source_srs}")
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

        # Fallback to simple string matching in projection text
        if not is_mercator:
            proj_upper = projection.upper()
            if '3857' in proj_upper or 'WEB_MERCATOR' in proj_upper or 'PSEUDO_MERCATOR' in proj_upper or 'POPULAR VISUALISATION' in proj_upper:
                is_mercator = True
                
        if is_mercator and not source_srs:
            print(f"[+] Coordinate system verified as EPSG:3857 (Web Mercator).")
            return input_path
    
    print(f"[!] Input {file_label} is not EPSG:3857 (detected EPSG code: {epsg_code or 'Unknown'}).")
    print(f"[*] Reprojecting {file_label} to EPSG:3857 (Web Mercator)...")
    
    reprojected_tif = os.path.join(output_dir, f"temp_reprojected_{file_label.replace(' ', '_')}.tif")
    
    try:
        # Define warp options
        warp_kwargs = {
            "dstSRS": "EPSG:3857",
            "resampleAlg": gdal.GRA_NearestNeighbour, # Preserve original values
            "creationOptions": ["COMPRESS=LZW", "TILED=YES"]
        }
        # If we have an override source SRS or the file was unprojected
        if not projection or source_srs:
            warp_kwargs["srcSRS"] = source_srs or epsg_code
            
        gdal.Warp(reprojected_tif, dataset, **warp_kwargs)
        print(f"[+] Reprojected file saved temporarily to: {reprojected_tif}")
        return reprojected_tif
    except Exception as e:
        print(f"[!] Warning: Reprojection failed ({e}). Attempting to process original file...")
        return input_path

def classify_and_colorize_slope(slope_path, output_path):
    """
    Reads the slope raster and writes out a transparent classified RGBA GeoTIFF.
    Processes the image block-by-block using windows to avoid Out-Of-Memory (OOM) errors.
    """
    print(f"[*] Running windowed classification and colorization on: {slope_path}")
    
    with rasterio.open(slope_path) as src:
        # Clone metadata and update to 4-band RGBA (uint8) for color display
        meta = src.meta.copy()
        meta.update(
            count=4, 
            dtype=rasterio.uint8, 
            nodata=0 # 0 means fully transparent for uncalculated areas
        )

        width = src.width
        height = src.height
        total_blocks = len(list(src.block_windows()))
        processed_blocks = 0

        print(f"[*] Processing {width}x{height} raster in {total_blocks} block windows...")

        with rasterio.open(output_path, 'w', **meta) as dst:
            for ij, window in src.block_windows():
                # Read 1 band of slope values for this window
                slope_block = src.read(1, window=window)
                
                # Allocate RGBA block [bands, height, width]
                # Default values set to 0 (fully transparent, black)
                rgba_block = np.zeros((4, window.height, window.width), dtype=np.uint8)
                
                # Apply colors based on slope thresholds
                for category, rgba in COLOR_MAP.items():
                    min_val, max_val = SLOPE_THRESHOLDS[category]
                    mask = (slope_block >= min_val) & (slope_block < max_val)
                    
                    # Apply colors to RGB bands + alpha band
                    for band in range(4):
                        rgba_block[band, mask] = rgba[band]
                
                # Handle raw Nodata areas
                if src.nodata is not None:
                    nodata_mask = (slope_block == src.nodata)
                    rgba_block[3, nodata_mask] = 0
                
                # Handle NaNs (if any float invalid numbers exist)
                if np.issubdtype(slope_block.dtype, np.floating):
                    nan_mask = np.isnan(slope_block)
                    rgba_block[3, nan_mask] = 0

                # Write RGBA block to destination
                dst.write(rgba_block, window=window)
                
                processed_blocks += 1
                if processed_blocks % int(max(1, total_blocks / 10)) == 0 or processed_blocks == total_blocks:
                    percent = int(100 * processed_blocks / total_blocks)
                    print(f"    - Classified: {processed_blocks}/{total_blocks} blocks ({percent}%)")

    print(f"[+] Transparent RGBA slope overlay saved locally at: {output_path}")

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
        description="Calculates slope from DSM, reprojects, classifies, colorizes, and tiles it to standard Leaflet XYZ format without QGIS."
    )
    parser.add_argument("--input-dsm", required=True, help="Path to input DSM (elevation model) GeoTIFF")
    parser.add_argument("--output-dir", required=True, help="Directory to save the generated XYZ tiles")
    parser.add_argument("--zoom", default="12-21", help="Zoom levels to generate, e.g. 12-21 (default)")
    parser.add_argument("--source-srs", default=None, help="Force coordinate reference system for the input raster (e.g. EPSG:4326)")
    
    args = parser.parse_args()
    
    # Resolve absolute paths
    input_dsm = os.path.abspath(args.input_dsm)
    output_dir = os.path.abspath(args.output_dir)
    
    if not os.path.exists(input_dsm):
        print(f"[-] Error: Input file not found: {input_dsm}")
        sys.exit(1)
        
    os.makedirs(output_dir, exist_ok=True)
    
    # Track temporary files for cleanup
    temp_files = []
    
    try:
        # Step 1: Calculate raw slope (degrees) from DSM
        raw_slope_tif = os.path.join(output_dir, "temp_raw_slope.tif")
        temp_files.append(raw_slope_tif)
        print("[*] Calculating raw slope raster from DSM...")
        gdal.DEMProcessing(raw_slope_tif, input_dsm, "slope", computeEdges=True)
        
        # Step 2: Ensure coordinate system matches Web Mercator (EPSG:3857)
        process_tif = check_and_reproject_to_3857(raw_slope_tif, output_dir, "raw slope", args.source_srs)
        if process_tif != raw_slope_tif:
            temp_files.append(process_tif)
            
        # Step 3: Classify raw slope values into transparent colors block-by-block (OOM-proof)
        classified_rgba_tif = os.path.join(output_dir, "temp_classified_slope_overlay.tif")
        temp_files.append(classified_rgba_tif)
        classify_and_colorize_slope(process_tif, classified_rgba_tif)
        
        # Step 4: Slice the transparent RGBA TIFF into XYZ tiles
        s_srs_to_pass = args.source_srs if process_tif == raw_slope_tif else None
        run_gdal2tiles(classified_rgba_tif, output_dir, args.zoom, s_srs_to_pass)
        
        print(f"\n[+] SUCCESS: Transparent slope overlay tiles exported to: {output_dir}")
        
    except Exception as e:
        print(f"\n[-] Critical error during execution: {e}")
        sys.exit(1)
        
    finally:
        # Clean up all temporary files
        print("[*] Cleaning up temporary intermediate files...")
        for temp_file in temp_files:
            if os.path.exists(temp_file):
                try:
                    os.remove(temp_file)
                except Exception as e:
                    print(f"[!] Warning: Could not delete temporary file {temp_file}: {e}")

if __name__ == "__main__":
    main()
