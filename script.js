window.onerror = function (message, source, lineno, colno, error) {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
        statusDiv.textContent = `Error: ${message}`;
        statusDiv.style.color = 'red';
    }
    console.error("Global Error:", message, "at", source, ":", lineno);
};

let scene, camera, renderer, controls;
let points = [];
let mapTiles = []; // Store map tiles to toggle visibility
const fileInput = document.getElementById('fileInput');
const statusDiv = document.getElementById('status');
const sceneContainer = document.getElementById('scene-container');

// Initialize Three.js Scene
function init3DScene() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a); // Match bg-color
    scene.fog = new THREE.FogExp2(0x0f172a, 0.002);

    // Camera
    camera = new THREE.PerspectiveCamera(60, sceneContainer.clientWidth / sceneContainer.clientHeight, 0.1, 10000);
    camera.position.set(0, 50, 100);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(sceneContainer.clientWidth, sceneContainer.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    sceneContainer.appendChild(renderer.domElement);

    // Controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 1;
    controls.maxDistance = 5000;
    controls.maxPolarAngle = Math.PI / 2; // Don't go below ground

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    // Grid Helper (Ground)
    const gridHelper = new THREE.GridHelper(1000, 50, 0x38bdf8, 0x1e293b);
    scene.add(gridHelper);

    // Axes Helper
    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    // Handle Resize
    window.addEventListener('resize', onWindowResize, false);

    // Interaction
    window.addEventListener('mousemove', onMouseMove, false);

    animate();
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let hoveredPoint = null;

function onMouseMove(event) {
    // Calculate mouse position in normalized device coordinates
    // (-1 to +1) for both components
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update tooltip position
    tooltip.style.left = (event.clientX + 15) + 'px';
    tooltip.style.top = (event.clientY + 15) + 'px';
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = sceneContainer.clientWidth / sceneContainer.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(sceneContainer.clientWidth, sceneContainer.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();

    // Raycasting
    if (camera && scene) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(points);

        if (intersects.length > 0) {
            const object = intersects[0].object;

            if (hoveredPoint !== object) {
                // Reset previous
                if (hoveredPoint) hoveredPoint.material.color.setHex(0x38bdf8);

                // Highlight new
                hoveredPoint = object;
                hoveredPoint.material.color.setHex(0x22c55e); // Green on hover

                // Show tooltip
                tooltip.style.display = 'block';
                // Get basename (handle both / and \ just in case, though zip usually uses /)
                const basename = object.userData.name.split(/[/\\]/).pop();
                const name = basename.split('.')[0]; // Remove extension
                const height = object.userData.alt.toFixed(1);
                tooltip.innerHTML = `<strong>${name}</strong><br>Height: ${height}m`;
            }
        } else {
            if (hoveredPoint) {
                hoveredPoint.material.color.setHex(0x38bdf8);
                hoveredPoint = null;
                tooltip.style.display = 'none';
            }
        }
    }

    if (renderer && scene && camera) renderer.render(scene, camera);
}

init3DScene();

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    statusDiv.textContent = 'Processing ZIP file...';
    statusDiv.style.color = 'var(--accent-color)';

    try {
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);

        // Clear existing points
        points.forEach(p => scene.remove(p));
        points = [];

        const imagePromises = [];
        const validImages = [];

        zip.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && isImage(zipEntry.name) && !zipEntry.name.includes('__MACOSX')) {
                console.log(`Processing: ${zipEntry.name}`);
                const promise = zipEntry.async('blob').then(async (blob) => {
                    if (zipEntry.name.toLowerCase().endsWith('.heic')) {
                        console.warn(`HEIC format not fully supported by exif-js: ${zipEntry.name}`);
                    }

                    try {
                        const exifData = await getExifData(blob);
                        if (exifData && exifData.lat && exifData.lng) {
                            console.log(`Found GPS for: ${zipEntry.name}`, exifData);
                            validImages.push({
                                name: zipEntry.name,
                                blob: blob,
                                lat: exifData.lat,
                                lng: exifData.lng,
                                alt: exifData.alt || 0
                            });
                        } else {
                            console.warn(`No GPS data found for: ${zipEntry.name}`);
                        }
                    } catch (e) {
                        console.error(`Error reading EXIF for ${zipEntry.name}:`, e);
                    }
                });
                imagePromises.push(promise);
            }
        });

        await Promise.all(imagePromises);

        console.log(`Processed ${imagePromises.length} images. Valid: ${validImages.length}`);

        if (validImages.length === 0) {
            statusDiv.textContent = 'No images with GPS data found. Check console for details.';
            statusDiv.style.color = 'var(--error-color)';
            return;
        }

        // Calculate Center
        const center = getCenter(validImages);

        // Set global center for projection
        window.centerLat = center.lat;
        window.centerLng = center.lng;
        window.centerMercator = latLonToMercator(center.lat, center.lng);

        // Load Map Tiles
        await loadMapTiles(center.lat, center.lng);

        // Convert to Cartesian (Web Mercator)
        validImages.forEach(img => {
            const pos = gpsToCartesian(img.lat, img.lng, img.alt);
            createPoint(pos, img);
        });

        fitCameraToSelection();

        statusDiv.textContent = `Visualized ${validImages.length} images in 3D with Map Overlay.`;
        statusDiv.style.color = 'var(--success-color)';

    } catch (err) {
        console.error(err);
        statusDiv.textContent = 'Error processing file: ' + err.message;
        statusDiv.style.color = 'var(--error-color)';
    }
});

function fitCameraToSelection() {
    if (points.length === 0) {
        console.warn("fitCameraToSelection: No points to fit.");
        return;
    }

    const box = new THREE.Box3();
    points.forEach(mesh => {
        box.expandByObject(mesh);
    });

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    console.log("Bounding Box Center:", center);
    console.log("Bounding Box Size:", size);

    // Update controls target to center of data
    controls.target.copy(center);

    // Position camera to view the entire box
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 * Math.tan(fov * 2)); // Basic distance estimation

    console.log("Calculated Camera Distance:", cameraZ);

    // Add some padding
    cameraZ *= 1.5;

    // Ensure we don't get too close or too far if single point
    if (cameraZ < 100) cameraZ = 100;
    if (cameraZ > 5000) cameraZ = 5000;

    console.log("Clamped Camera Distance:", cameraZ);

    // Move camera relative to center
    // We want to look down at an angle
    camera.position.set(center.x, center.y + cameraZ, center.z + cameraZ);
    console.log("New Camera Position:", camera.position);

    camera.updateProjectionMatrix();
    controls.update();
}

// Bubble Size Slider
const bubbleSizeSlider = document.getElementById('bubbleSize');
const bubbleSizeValue = document.getElementById('bubbleSizeValue');

if (bubbleSizeSlider && bubbleSizeValue) {
    bubbleSizeSlider.addEventListener('input', (e) => {
        const size = parseFloat(e.target.value);
        bubbleSizeValue.textContent = size;

        // Update existing points
        points.forEach(point => {
            // Scale geometry or mesh? Scaling mesh is more efficient
            // Default radius was 5. We want the slider (1-20) to represent the radius.
            // So scale factor = size / 5
            const scale = size / 5;
            point.scale.set(scale, scale, scale);
        });
    });
}

// Bubble Color Picker
const bubbleColorPicker = document.getElementById('bubbleColor');

if (bubbleColorPicker) {
    bubbleColorPicker.addEventListener('input', (e) => {
        const color = e.target.value;
        points.forEach(point => {
            point.material.color.set(color);
            // Also update cone color if it exists
            const cone = point.children.find(child => child.type === 'Mesh' && child.geometry.type === 'ConeGeometry');
            if (cone) {
                cone.material.color.set(color);
            }
        });
    });
}

function createPoint(pos, imgData) {
    // console.log("Creating point at:", pos); // Uncomment if too spammy
    const geometry = new THREE.SphereGeometry(5, 32, 32);

    // Get current color
    let color = 0x38bdf8;
    if (bubbleColorPicker) {
        color = bubbleColorPicker.value;
    }

    const material = new THREE.MeshStandardMaterial({ color: color, roughness: 0.3, metalness: 0.8 });
    const sphere = new THREE.Mesh(geometry, material);

    sphere.position.set(pos.x, pos.y, pos.z);

    // Apply current slider size
    if (bubbleSizeSlider) {
        const size = parseFloat(bubbleSizeSlider.value);
        const scale = size / 5;
        sphere.scale.set(scale, scale, scale);
    }

    // Add direction cone if heading is available
    if (imgData.heading !== undefined && imgData.heading !== null) {
        const coneGeometry = new THREE.ConeGeometry(2, 6, 16); // Base radius 2, height 6
        const coneMaterial = new THREE.MeshStandardMaterial({ color: color, roughness: 0.3, metalness: 0.8 });
        const cone = new THREE.Mesh(coneGeometry, coneMaterial);

        // Align cone to point North (-Z) by default (Cone points +Y)
        cone.geometry.rotateX(-Math.PI / 2);

        // Rotate to match heading (clockwise from North)
        // Three.js Y rotation is CCW, so we negate the heading
        const headingRad = THREE.MathUtils.degToRad(imgData.heading);
        cone.rotation.y = -headingRad;

        // Position cone slightly outside the sphere
        // We want it to be visible on the surface or just outside
        // Sphere radius is 5 (scaled). Let's put it at distance 7?
        // Actually, let's just add it to the sphere and offset it?
        // If we add to sphere, it scales with sphere.
        // Let's put it on top/front?
        // Better: Put it at the center but rotated, and moved forward along its local -Z axis?
        // Or just rotate the whole sphere? No, sphere rotation doesn't matter visually.
        // Let's just add the cone to the sphere.

        // Move cone forward in its local -Z direction (which is North relative to the cone)
        // But we rotated the geometry, so local Z is correct.
        // Actually, if we rotate the mesh, we can just translate Z.

        // Let's try this:
        // Cone is child of sphere.
        // Cone geometry points -Z.
        // Cone mesh is rotated by -heading around Y.
        // Cone position is 0,0,0 relative to sphere.
        // But we want it to "stick out".
        // Maybe we don't make it a child, or we do but we offset it.

        // Simpler:
        // Cone points in direction.
        // Position is slightly offset from center in that direction.
        // But if we scale the sphere, the offset needs to scale.
        // If it's a child, it scales automatically!

        // So:
        // 1. Cone points -Z (North).
        // 2. Translate cone -Z by radius (5) + half height (3) = 8.
        // 3. Rotate cone container?

        // Let's use a pivot group or just rotate the cone mesh?
        // If we translate geometry, rotation rotates the position too.
        cone.geometry.translate(0, 0, -8); // Move forward along -Z

        sphere.add(cone);
    }

    // Add user data for interaction later
    sphere.userData = { ...imgData };

    scene.add(sphere);
    points.push(sphere);
}

function getCenter(images) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    images.forEach(img => {
        minLat = Math.min(minLat, img.lat);
        maxLat = Math.max(maxLat, img.lat);
        minLng = Math.min(minLng, img.lng);
        maxLng = Math.max(maxLng, img.lng);
    });

    return {
        lat: (minLat + maxLat) / 2,
        lng: (minLng + maxLng) / 2
    };
}

// Web Mercator Projection
const R = 6378137; // Earth radius in meters (WGS84 major axis)

function latLonToMercator(lat, lon) {
    const x = R * THREE.MathUtils.degToRad(lon);
    const y = R * Math.log(Math.tan(Math.PI / 4 + THREE.MathUtils.degToRad(lat) / 2));
    return { x, y };
}

function gpsToCartesian(lat, lng, alt) {
    const mercator = latLonToMercator(lat, lng);

    // Relative to center
    const x = mercator.x - window.centerMercator.x;
    const z = -(mercator.y - window.centerMercator.y); // Invert Y for 3D Z
    const y = alt;

    return { x, y, z };
}

// Map Tile Loading
async function loadMapTiles(lat, lng) {
    // Clear existing tiles
    mapTiles.forEach(tile => scene.remove(tile));
    mapTiles = [];

    const zoom = 19; // High zoom for detail
    const tileX = long2tile(lng, zoom);
    const tileY = lat2tile(lat, zoom);

    // Load a 3x3 grid centered on the data
    const radius = 2;
    const textureLoader = new THREE.TextureLoader();

    for (let x = tileX - radius; x <= tileX + radius; x++) {
        for (let y = tileY - radius; y <= tileY + radius; y++) {
            const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;

            // Calculate tile position in 3D space
            // Tile size in meters at this zoom
            const tileSizeMeters = (2 * Math.PI * R) / Math.pow(2, zoom); // Earth circumference / 2^zoom

            // Tile center in Mercator coordinates
            const tileCenterMercatorX = ((x + 0.5) / Math.pow(2, zoom)) * (2 * Math.PI * R) - (Math.PI * R);
            const tileCenterMercatorY = (Math.PI * R) - ((y + 0.5) / Math.pow(2, zoom)) * (2 * Math.PI * R);

            const posX = tileCenterMercatorX - window.centerMercator.x;
            const posZ = -(tileCenterMercatorY - window.centerMercator.y);

            textureLoader.load(url, (texture) => {
                const geometry = new THREE.PlaneGeometry(tileSizeMeters, tileSizeMeters);
                const material = new THREE.MeshBasicMaterial({ map: texture });
                const plane = new THREE.Mesh(geometry, material);

                plane.rotation.x = -Math.PI / 2; // Rotate to be flat on ground
                plane.position.set(posX, -0.5, posZ); // Slightly below 0 to avoid z-fighting

                // Check initial toggle state
                const toggle = document.getElementById('mapToggle');
                if (toggle) {
                    plane.visible = toggle.checked;
                }

                scene.add(plane);
                mapTiles.push(plane);
            });
        }
    }
}

// Map Toggle Event Listener
const mapToggle = document.getElementById('mapToggle');
if (mapToggle) {
    mapToggle.addEventListener('change', (e) => {
        const isVisible = e.target.checked;
        mapTiles.forEach(tile => {
            tile.visible = isVisible;
        });
    });
}

function long2tile(lon, zoom) {
    return (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
}

function lat2tile(lat, zoom) {
    return (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));
}

function isImage(filename) {
    return /\.(jpg|jpeg|png|heic)$/i.test(filename);
}

function getExifData(blob) {
    return new Promise((resolve, reject) => {
        if (typeof EXIF === 'undefined') {
            reject(new Error('exif-js library not loaded'));
            return;
        }

        // Timeout after 2 seconds to prevent hanging
        const timeoutId = setTimeout(() => {
            resolve(null);
        }, 2000);

        try {
            EXIF.getData(blob, function () {
                clearTimeout(timeoutId);
                const lat = EXIF.getTag(this, "GPSLatitude");
                const latRef = EXIF.getTag(this, "GPSLatitudeRef");
                const lng = EXIF.getTag(this, "GPSLongitude");
                const lngRef = EXIF.getTag(this, "GPSLongitudeRef");
                const alt = EXIF.getTag(this, "GPSAltitude");
                const altRef = EXIF.getTag(this, "GPSAltitudeRef");

                // Direction
                const dir = EXIF.getTag(this, "GPSImgDirection");
                const dirRef = EXIF.getTag(this, "GPSImgDirectionRef"); // 'T' for True, 'M' for Magnetic

                if (lat && latRef && lng && lngRef) {
                    const decimalLat = convertDMSToDD(lat, latRef);
                    const decimalLng = convertDMSToDD(lng, lngRef);

                    let altitude = 0;
                    if (alt !== undefined && alt !== null) {
                        altitude = parseFloat(alt);
                        if (altRef === 1) altitude = -altitude;
                    }

                    let heading = null;
                    if (dir !== undefined && dir !== null) {
                        heading = parseFloat(dir);
                    }

                    resolve({
                        lat: decimalLat,
                        lng: decimalLng,
                        alt: altitude,
                        heading: heading
                    });
                } else {
                    resolve(null);
                }
            });
        } catch (e) {
            clearTimeout(timeoutId);
            console.error("EXIF.getData error:", e);
            resolve(null);
        }
    });
}

function convertDMSToDD(dms, ref) {
    let dd = dms[0] + dms[1] / 60 + dms[2] / 3600;
    if (ref === "S" || ref === "W") {
        dd = dd * -1;
    }
    return dd;
}
