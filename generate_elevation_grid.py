#!/usr/bin/env python3
"""
Safety Workflows - Elevation Grid Generator
=========================================
This script takes a digital surface model (DSM) GeoTIFF, reprojects it to EPSG:4326 (WGS84),
and downsamples it to a lightweight 2D JSON grid. The client-side application can load this
JSON file to calculate elevation profiles and slope gradients for drawn lines in real time
without needing a backend database or GIS server.

Requirements:
- GDAL Python bindings (osgeo.gdal)
"""

import json
import os
import sys
import argparse
import math
from osgeo import gdal, osr

def main():
    parser = argparse.ArgumentParser(
        description="Generates a lightweight elevation grid JSON from a DSM GeoTIFF for client-side slope calculation."
    )
    parser.add_argument("--input-dsm", required=True, help="Path to the input DSM GeoTIFF")
    parser.add_argument("--output-json", default="public/elevation_grid.json", help="Path to save the output JSON (default: public/elevation_grid.json)")
    parser.add_argument("--grid-size", type=int, default=150, help="Resolution of the elevation grid, e.g. 150 (default)")
    
    args = parser.parse_args()
    
    input_dsm = os.path.abspath(args.input_dsm)
    output_json = os.path.abspath(args.output_json)
    
    if not os.path.exists(input_dsm):
        print(f"[-] Error: Input DSM file not found: {input_dsm}")
        sys.exit(1)
        
    print(f"[*] Processing DSM: {input_dsm}")
    
    try:
        dataset = gdal.Open(input_dsm)
        grid_size = args.grid_size
        
        # Warp directly to a memory-backed dataset in EPSG:4326 and target resolution
        print(f"[*] Reprojecting and resampling DSM to WGS84 ({grid_size}x{grid_size} grid)...")
        warp_options = gdal.WarpOptions(
            dstSRS="EPSG:4326",
            width=grid_size,
            height=grid_size,
            resampleAlg=gdal.GRA_Bilinear,
            outputType=gdal.GDT_Float32,
            format='MEM'  # CRITICAL: Define memory format inside WarpOptions to prevent GTiff file creation error
        )
        
        warped_ds = gdal.Warp('', dataset, options=warp_options)
        band = warped_ds.GetRasterBand(1)
        elevation_data = band.ReadAsArray()
        
        # Read geotransform to compute geographic coordinates
        geotransform = warped_ds.GetGeoTransform()
        ul_lon = geotransform[0]
        pixel_width = geotransform[1]
        ul_lat = geotransform[3]
        pixel_height = geotransform[5]
        
        # Calculate bounding envelope
        lon_min = ul_lon
        lon_max = ul_lon + pixel_width * grid_size
        lat_max = ul_lat
        lat_min = ul_lat + pixel_height * grid_size
        
        # Parse nodata value
        nodata = band.GetNoDataValue()
        
        # Construct grid, handling nodata/unreasonable heights
        grid = []
        for r in range(grid_size):
            row = []
            for c in range(grid_size):
                val = float(elevation_data[r, c])
                if math.isnan(val) or val == nodata or val < -500 or val > 9000:
                    row.append(None)
                else:
                    row.append(round(val, 2))
            grid.append(row)
            
        output_data = {
            "bounds": {
                "latMin": lat_min,
                "latMax": lat_max,
                "lonMin": lon_min,
                "lonMax": lon_max
            },
            "rows": grid_size,
            "cols": grid_size,
            "grid": grid
        }
        
        # Save output JSON
        os.makedirs(os.path.dirname(output_json), exist_ok=True)
        with open(output_json, 'w') as f:
            json.dump(output_data, f, indent=2)
            
        print(f"\n[+] SUCCESS: Generated elevation grid JSON at: {output_json}")
        print(f"    Grid Resolution: {grid_size} x {grid_size}")
        print(f"    Latitude Bounds: {lat_min:.6f} to {lat_max:.6f}")
        print(f"    Longitude Bounds: {lon_min:.6f} to {lon_max:.6f}")
        
    except Exception as e:
        print(f"[-] Critical error during execution: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
