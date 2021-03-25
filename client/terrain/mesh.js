// A rewrite of the terrain code to be more modular.
// TODO: Fix the missing roof configurations (diagonally joined roofs)
// TODO: possible performance optimization: texture atlases to reduce texture swaps

class TerrainMesh {
    constructor(metadata, params, raw, mesh, walls, roofs, wireframe, collision) {
        this.metadata = metadata;
        this.params = params;
        this.raw = raw;

        this.scene = undefined;
        this.showRoofs = true;

        this.mesh = mesh;
        this.walls = walls;
        this.roofs = roofs;
        this.wireframe = wireframe;
        this.collision = collision;
    }

    toggleRoofs() {
        this.setIndoorStatus(!this.showRoofs);
    }

    setIndoorStatus(indoors) {
        if (indoors && this.showRoofs) {
            if (this.scene) this.scene.remove(this.roofs);
            this.showRoofs = false;
        } else if (!indoors && !this.showRoofs) {
            if (this.scene) this.scene.add(this.roofs);
            this.showRoofs = true;
        }
    }

    addToScene(scene) {
        if (this.scene) throw "Already in scene";

        this.scene = scene;
        this.scene.add(this.mesh);
        this.scene.add(this.wireframe);
        this.scene.add(this.walls);
        if (this.showRoofs) this.scene.add(this.roofs);
    }

    removeFromScene() {
        if (!this.scene) throw "Not in a scene.";

        this.scene.remove(this.mesh);
        this.scene.remove(this.wireframe);
        this.scene.remove(this.walls);
        if (this.showRoofs) this.scene.remove(this.roofs);
        delete this.scene;
    }

    /*isInside(localX, localY) {
        let xx = Math.floor(localX), yy = Math.floor(localY);
        if (xx < 0 || yy < 0 || xx >= wSIZE || yy >= wSIZE) return false;
        return this.mesh[xx][yy].indoor || false;
    }*/

    // TODO: Make this better?
    heightAt(x,y) {
        let xx = MOD(Math.floor(x),this.metadata.wSIZE);
        let yy = MOD(Math.floor(y),this.metadata.wSIZE);

        if (this.raw[xx][yy].override) {
            return this.raw[xx][yy].override;
        }

        let xxp = xx + 1 > this.metadata.wSIZE ? xx : xx + 1, yyp = yy + 1 > this.metadata.wSIZE ? yy : yy + 1;
        let px = 1.0 - (x - xx) / 1.0, py = 1.0 - (y - yy) / 1.0;

        let p0 = this.elevation(xx,yy);
        let p1 = this.elevation(xxp,yy);
        let p2 = this.elevation(xx,yyp);
        let p3 = this.elevation(xxp,yyp);

        let h0 = p0 * px + p1 * (1 - px);
        let h1 = p2 * px + p3 * (1 - px);
        let h = h0 * py + h1 * (1 - py);
        return h;
    }

    tileHeights(x,y) {
        let xx = MOD(Math.floor(x),this.metadata.wSIZE);
        let yy = MOD(Math.floor(y),this.metadata.wSIZE);
        let xxp = xx + 1 > this.metadata.wSIZE ? xx : xx + 1, yyp = yy + 1 > this.metadata.wSIZE ? yy : yy + 1;

        let p0 = this.elevation(xx,yy);
        let p1 = this.elevation(xxp,yy);
        let p2 = this.elevation(xx,yyp);
        let p3 = this.elevation(xxp,yyp);
        return [p0,p1,p2,p3];
    }

    elevation(xx, yy) {
        return this.raw[xx][yy].elevation || 0.0;
    }

    getTile(x, y) {
        return this.raw[Math.floor(x)][Math.floor(y)];
    }
}

function MOD(x,y) {
    return ((x%y)+y)%y;
}

const TEXTURE_LIGHT = new THREE.Color(1,1,1);
const TEXTURE_SHADOW = new THREE.Color(0.7,0.7,0.7);

let u0 = new THREE.Vector2(0,0);
let u1 = new THREE.Vector2(1,0);
let u2 = new THREE.Vector2(1,1);
let u3 = new THREE.Vector2(0,1);

let uHalf = new THREE.Vector2(0.5,1);
let uHalfLeft = new THREE.Vector2(-0.5,1);

const diaga_uvs_0 = [u0, u3, u2];
const diaga_uvs_1 = [u0, u2, u1];
const diagb_uvs_0 = [u0, u3, u1];
const diagb_uvs_1 = [u1, u3, u2];

const DEFAULT_COLOR = new THREE.Color(); 
const SHADOW_COLOR = new THREE.Color(0.7,0.7,0.7);

function createFace(v0, v1, v2, material, shade) {
    let face = new THREE.Face3(v0, v1, v2);
    face.materialIndex = material;
    if (shade) {
        face.vertexColors[0] = shade;
        face.vertexColors[1] = shade;
        face.vertexColors[2] = shade;
    }
    return face;
}

function createWaterShader(texture) {
    let uniforms = {
        texture: { type: "t", value: texture },
        u_time: DATA.shader_uniforms.u_time,
    }

    let shaderMaterial = new THREE.ShaderMaterial({
        uniforms: uniforms,
        vertexShader: 
            " attribute vec2 flow; " +
            " varying vec2 vFlow; " +

            " varying vec3 vColor; " +
            " varying vec2 vUv; " +
            " varying vec3 vPosition; " +
            " void main() " +
            " {" +
            " vUv = uv; vColor = color; vPosition = position; vFlow = flow; " +
            " vec4 modelViewPosition = modelViewMatrix * vec4(position, 1.0);" +
            " gl_Position = projectionMatrix * modelViewPosition; " +
            " }",
        fragmentShader: DATA.water_shader,
        vertexColors: THREE.VertexColors
    });
    return shaderMaterial;
}

class MeshLoader {
    constructor() {}

    useMetadata(metadata) {
        this.metadata = metadata;
    }

    useWallDefinitions(walls) {
        this.walls = walls;
    }

    useRoofDefinitions(roofs) {
        this.roofs = roofs;
    }

    useTextureManager(textureManager) {
        this.textureManager = textureManager;
    }

    /**
     * Iterates over all tiles in the mesh and populates a vertex for
     * every x/y coordinate in the mesh.
     */
    prepareVertices(mesh) {
        const geometries = [];

        for (let x = 0; x <= this.metadata.wSIZE; x++) {
            geometries[x] = [];
            for (let y = 0; y <= this.metadata.wSIZE; y++) {
                const tile = mesh[x][y];

                // Defaulting
                tile.draw ||= 'blend';
                tile.orientation ||= 'diagb';

                if (tile.color) {
                    tile.threeColor = new THREE.Color(tile.color.r / 255, tile.color.g / 255, tile.color.b / 255);
                    tile.threeShadowColor =
                        new THREE.Color(
                            0.7 * tile.color.r / 255,
                            0.7 * tile.color.g / 255,
                            0.7 * tile.color.b / 255);
                } else {
                    tile.threeColor = new THREE.Color(1.0, 1.0, 1.0);
                    tile.threeShadowColor = new THREE.Color(1.0, 1.0, 1.0);
                }

                if (tile.water) {
                    const w = tile.water;
                    let flowX = w.flowX || 0.0;
                    let flowY = w.flowY || 0.0;

                    // normalize vector.
                    const len = Math.sqrt(flowX * flowX + flowY * flowY);
                    flowX /= len;
                    flowY /= len;

                    const speed = w.flowSpeed || 0.0;
                    flowX *= speed;
                    flowY *= speed;

                    tile.waterFlow = [flowX, flowY];

                    const depth = w.depth || 0;

                    const r = 128 + Math.floor(127 * flowX / WATER_ENCODE_RANGE);
                    const g = 128 + Math.floor(127 * flowY / WATER_ENCODE_RANGE);
                    const b = Math.floor(255 * w.depth / 3.0);

                    tile.threeWaterColor = new THREE.Color(r / 255.0, g / 255.0, b / 255.0, 1.0);
                } else {
                    tile.threeWaterColor = new THREE.Color(1.0, 1.0, 1.0)
                }

                if (!tile.color && !tile.texture1 && !tile.texture2) {
                    tile.draw = 'none';
                }

                const pos = {
                    bottomLeft: new THREE.Vector3(x, tile.elevation || 0.0, y + 1),
                    topLeft: new THREE.Vector3(x, tile.elevation || 0.0, y),
                    bottomRight: new THREE.Vector3(x + 1, tile.elevation || 0.0, y + 1),
                    topRight: new THREE.Vector3(x + 1, tile.elevation || 0.0, y)
                };

                geometries[x][y] = new THREE.Geometry();
                geometries[x][y].vertices.push(pos.topLeft, pos.topRight, pos.bottomLeft, pos.bottomRight);
            }
        }

        return geometries;



        /*const geometry = new THREE.Geometry();
        let curId = 0;

        const vertices = [];
        for (let x = 0; x <= this.metadata.wSIZE; x++) {
            if (!mesh[x]) {
                mesh[x] = [];
            }

            vertices[x] = [];

            for (let y = 0; y <= this.metadata.wSIZE; y++) {
                if (!mesh[x][y]) {
                    mesh[x][y] = { color: {r:255, g:255,b:255} };
                }

                const tile = mesh[x][y];

                // Defaulting
                tile.draw ||= 'blend';
                tile.orientation ||= 'diagb';

                if (tile.color) {
                    tile.threeColor = new THREE.Color(tile.color.r / 255, tile.color.g / 255, tile.color.b / 255);
                    tile.threeShadowColor =
                        new THREE.Color(
                            0.7 * tile.color.r / 255,
                            0.7 * tile.color.g / 255,
                            0.7 * tile.color.b / 255);
                } else {
                    tile.threeColor = new THREE.Color(1.0, 1.0, 1.0);
                    tile.threeShadowColor = new THREE.Color(1.0, 1.0, 1.0);
                }

                if (tile.water) {
                    const w = tile.water;
                    let flowX = w.flowX || 0.0;
                    let flowY = w.flowY || 0.0;

                    // normalize vector.
                    const len = Math.sqrt(flowX * flowX + flowY * flowY);
                    flowX /= len;
                    flowY /= len;

                    const speed = w.flowSpeed || 0.0;
                    flowX *= speed;
                    flowY *= speed;

                    tile.waterFlow = [flowX, flowY];

                    const depth = w.depth || 0;

                    const r = 128 + Math.floor(127 * flowX / WATER_ENCODE_RANGE);
                    const g = 128 + Math.floor(127 * flowY / WATER_ENCODE_RANGE);
                    const b = Math.floor(255 * w.depth / 3.0);

                    tile.threeWaterColor = new THREE.Color(r / 255.0, g / 255.0, b / 255.0, 1.0);
                } else {
                    tile.threeWaterColor = new THREE.Color(1.0, 1.0, 1.0)
                }

                if (!tile.color && !tile.texture1 && !tile.texture2) {
                    tile.draw = 'none';
                }

                const pos = new THREE.Vector3(x, tile.elevation || 0.0, y);

                vertices[x][y] = { 
                    vector: pos,
                    index: curId++
                };

                geometry.vertices.push(pos);
            }
        }
        return { geometry, vertices };*/
    }

    materialIndex(materials, materialMap, type, texture, prefix) {
        if (!texture) return 0;
        if (materialMap[texture]) return materialMap[texture];

        let material;
        let map = this.textureManager.get(prefix + texture);
        if (window.DATA && texture == 'water.png') {
            material = createWaterShader(
                //this.textureManager.get('uv.png')
                map
            );
        } else if (type == 'lambert') {
            material = new THREE.MeshLambertMaterial( { 
                vertexColors: THREE.VertexColors,
                map: map,
                side: THREE.FrontSide
            });
        } else if (type == 'basic') {
            material = new THREE.MeshBasicMaterial({
                vertexColors: THREE.VertexColors,
                map: map,
                transparent: true,
                alphaTest: 0.5,
                side: THREE.DoubleSide
            });
        } else if (type == 'wireframe') {
            material = new THREE.MeshBasicMaterial({
                color: 'yellow',
                wireframe: true,
                alphaTest: 0.5,
                side: THREE.DoubleSide
            });
        }
        materialMap[texture] = materials.length;
        materials.push(material);

        return materialMap[texture];
    }
    
    // Figures out the neighbor vertex colors for t00.
    computeVertexColors(t00, t01, t10, t11) {
        return {
            "00": !t00.shadow ? t00.threeColor : t00.threeShadowColor,
            "01": !t01.shadow ? t01.threeColor : t01.threeShadowColor,
            "10": !t10.shadow ? t10.threeColor : t10.threeShadowColor,
            "11": !t11.shadow ? t11.threeColor : t11.threeShadowColor,

            "w00": t00.threeWaterColor,
            "w01": t01.threeWaterColor,
            "w10": t10.threeWaterColor,
            "w11": t11.threeWaterColor,

            // TODO: do we want texture coloring?
            "t00": !t00.shadow ? TEXTURE_LIGHT : TEXTURE_SHADOW,
            "t01": !t01.shadow ? TEXTURE_LIGHT : TEXTURE_SHADOW,
            "t10": !t10.shadow ? TEXTURE_LIGHT : TEXTURE_SHADOW,
            "t11": !t11.shadow ? TEXTURE_LIGHT : TEXTURE_SHADOW,
        }
    }

    /**
     * Iterates over all tiles and actually creates the terrain faces
     * for those tiles.
     */
    populateGeometry(tiles, geometries) {
        const materials = [
            new THREE.MeshLambertMaterial( {
                vertexColors: THREE.VertexColors,
                side: THREE.FrontSide
            })
        ];
        const materialMap = {};

        const meshes = [];

        for (let x = 0; x < this.metadata.wSIZE; x++) {
            for (let y = 0; y < this.metadata.wSIZE; y++) {
                const tile = tiles[x][y];
                const geometry = geometries[x][y];

                if (tile.draw === 'none') continue;

                const getIndex = (x, y) => x * this.metadata.wSIZE + y;

                let v00 = 0; //topleft
                let v10 = 1; //bottomleft
                let v01 = 2; //topright
                let v11 = 3; //bottomright

                let face1, face2;

                const material1 = this.materialIndex(materials, materialMap, 'lambert', tile.texture1, 'buildings/floors/');
                const material2 = this.materialIndex(materials, materialMap, 'lambert', tile.texture2, 'buildings/floors/');

                const vertexColors = this.computeVertexColors(tiles[x][y], tiles[x][y+1], tiles[x+1][y], tiles[x+1][y+1]);

                const draw1 = !(material1 === 0 && !tile.color);
                const draw2 = !(material2 === 0 && !tile.color);

                if (tile.orientation === 'diaga') {
                    face1 = new THREE.Face3(v00, v01, v11);
                    face2 = new THREE.Face3(v00, v11, v10);

                    const prefix1 = tile.texture1 === 'water.png' ? "w" : material1 === 0 ? "" : "t";
                    face1.vertexColors[0] = vertexColors[prefix1 + "00"];
                    face1.vertexColors[1] = vertexColors[prefix1 + "01"];
                    face1.vertexColors[2] = vertexColors[prefix1 + "11"];

                    const prefix2 = tile.texture2 === 'water.png' ? "w" : material2 === 0 ? "" : "t";
                    face2.vertexColors[0] = vertexColors[prefix2 + "00"];
                    face2.vertexColors[1] = vertexColors[prefix2 + "11"];
                    face2.vertexColors[2] = vertexColors[prefix2 + "10"];

                    if (draw1) {
                        geometry.faceVertexUvs[0].push(diaga_uvs_0);
                    }

                    if (draw2) {
                        geometry.faceVertexUvs[0].push(diaga_uvs_1);
                    }
                } else {
                    face1 = new THREE.Face3(v00, v01, v10);
                    face2 = new THREE.Face3(v10, v01, v11);

                    const prefix1 = tile.texture1 === 'water.png' ? "w" : material1 === 0 ? "" : "t";
                    face1.vertexColors[0] = vertexColors[prefix1 + "00"];
                    face1.vertexColors[1] = vertexColors[prefix1 + "01"];
                    face1.vertexColors[2] = vertexColors[prefix1 + "10"];

                    const prefix2 = tile.texture2 === 'water.png' ? "w" : material2 === 0 ? "" : "t";
                    face2.vertexColors[0] = vertexColors[prefix2 + "10"];
                    face2.vertexColors[1] = vertexColors[prefix2 + "01"];
                    face2.vertexColors[2] = vertexColors[prefix2 + "11"];

                    if (draw1) {
                        geometry.faceVertexUvs[0].push(diagb_uvs_0);
                    }

                    if (draw2) {
                        geometry.faceVertexUvs[0].push(diagb_uvs_1);
                    }
                }

                face1.materialIndex = material1;
                face2.materialIndex = material2;

                const flow = [];

                if (draw1) {
                    geometry.faces.push(face1);
                    for (let i = 0; i < 3; i++) {
                        flow.push(tile.waterFlow ? tile.waterFlow[0] : 0.0);
                        flow.push(tile.waterFlow ? tile.waterFlow[1] : 0.0);
                    }
                }

                if (draw2) {
                    geometry.faces.push(face2);
                    for (let i = 0; i < 3; i++) {
                        flow.push(tile.waterFlow ? tile.waterFlow[0] : 0.0);
                        flow.push(tile.waterFlow ? tile.waterFlow[1] : 0.0);
                    }
                }

                geometry.computeFaceNormals();
                geometry.computeVertexNormals();

                const bufferGeometry = new THREE.BufferGeometry().fromGeometry(geometry);
                bufferGeometry.addAttribute('flow', new THREE.Float32BufferAttribute(Float32Array.from(flow), 2));

                const mesh = new THREE.Mesh(bufferGeometry, materials);
                mesh.matrixAutoUpdate = false;

                meshes.push(mesh);
            }
        }

        return meshes;
        /*// Keep track of which material each texutre corresponds to.
        let materials = [];
        let materialMap = {};
        materials.push(new THREE.MeshLambertMaterial( { 
            vertexColors: THREE.VertexColors,
            side: THREE.FrontSide,
            //wireframe: true,
        }));

        // Extract for simpler code
        let vertices = preparedVertices.vertices;
        let geometry = preparedVertices.geometry;

        let flow = [];

        for (let x = 0; x < this.metadata.wSIZE; x++) {
            for (let y = 0; y < this.metadata.wSIZE; y++) {
                let tile = tiles[x][y];
                //  tile.draw == none -> do not draw this tile
                if (tile.draw == 'none') continue;

                let v00 = vertices[x][y].index;
                let v10 = vertices[x + 1][y].index;
                let v11 = vertices[x + 1][y + 1].index;
                let v01 = vertices[x][y + 1].index;

                let face1, face2;

                let material1 = this.materialIndex(materials, materialMap, 'lambert', tile.texture1, 'buildings/floors/');
                let material2 = this.materialIndex(materials, materialMap, 'lambert', tile.texture2, 'buildings/floors/');

                let vertexColors = this.computeVertexColors(tiles[x][y], tiles[x][y+1], tiles[x+1][y], tiles[x+1][y+1]);

                let draw1 = true;
                let draw2 = true;

                if (material1 == 0 && !tile.color) draw1 = false;
                if (material2 == 0 && !tile.color) draw2 = false;

                if (tile.orientation == 'diaga') {
                    face1 = new THREE.Face3(v00,v01,v11);
                    face2 = new THREE.Face3(v00,v11,v10);

                    let prefix1 = tile.texture1 == 'water.png' ? "w" : material1 == 0 ? "" : "t";
                    face1.vertexColors[0] = vertexColors[prefix1 + "00"];
                    face1.vertexColors[1] = vertexColors[prefix1 + "01"];
                    face1.vertexColors[2] = vertexColors[prefix1 + "11"];

                    let prefix2 = tile.texture2 == 'water.png' ? "w" : material2 == 0 ? "" : "t";
                    face2.vertexColors[0] = vertexColors[prefix2 + "00"];
                    face2.vertexColors[1] = vertexColors[prefix2 + "11"];
                    face2.vertexColors[2] = vertexColors[prefix2 + "10"];

                    if (draw1) {
                        geometry.faceVertexUvs[0].push(diaga_uvs_0);
                    }
                    if (draw2) {
                        geometry.faceVertexUvs[0].push(diaga_uvs_1);
                    }
                } else {
                    face1 = new THREE.Face3(v00,v01,v10);
                    face2 = new THREE.Face3(v10,v01,v11);

                    let prefix1 = tile.texture1 == 'water.png' ? "w" : material1 == 0 ? "" : "t";
                    face1.vertexColors[0] = vertexColors[prefix1 + "00"];
                    face1.vertexColors[1] = vertexColors[prefix1 + "01"];
                    face1.vertexColors[2] = vertexColors[prefix1 + "10"];

                    let prefix2 = tile.texture2 == 'water.png' ? "w" : material2 == 0 ? "" : "t";
                    face2.vertexColors[0] = vertexColors[prefix2 + "10"];
                    face2.vertexColors[1] = vertexColors[prefix2 + "01"];
                    face2.vertexColors[2] = vertexColors[prefix2 + "11"];

                    if (draw1) {
                        geometry.faceVertexUvs[0].push(diagb_uvs_0);
                    }
                    if (draw2) {
                        geometry.faceVertexUvs[0].push(diagb_uvs_1);
                    }
                }

                face1.materialIndex = material1;
                face2.materialIndex = material2;

                if (draw1) {
                    geometry.faces.push(face1);
                    for (let i = 0; i < 3; i++) {
                        flow.push(tile.waterFlow ? tile.waterFlow[0] : 0.0);
                        flow.push(tile.waterFlow ? tile.waterFlow[1] : 0.0);
                    }
                }
                if (draw2) {
                    geometry.faces.push(face2);
                    for (let i = 0; i < 3; i++) {
                        flow.push(tile.waterFlow ? tile.waterFlow[0] : 0.0);
                        flow.push(tile.waterFlow ? tile.waterFlow[1] : 0.0);
                    }
                }
            }
        }

        geometry.computeFaceNormals();
        geometry.computeVertexNormals();

        let buffergeometry = new THREE.BufferGeometry().fromGeometry(geometry);
        buffergeometry.addAttribute('flow', new THREE.Float32BufferAttribute(Float32Array.from(flow), 2));

        let mesh = new THREE.Mesh(buffergeometry, materials);
        mesh.matrixAutoUpdate = false;
        return mesh;*/
    }

    _getWallDrawingData(position, tile, tiles, x, y, heightOffset, invert) {
        let startTile;
        let endTile;
        let shade;

        if (position === 'plusx' && x < this.metadata.wSIZE) {
            startTile = tile;
            endTile = tiles[x + 1][y];
            shade = DEFAULT_COLOR;
        } else if (position === 'plusy' && y < this.metadata.wSIZE) {
            startTile = tile;
            endTile = tiles[x][y + 1];
            shade = SHADOW_COLOR;
        } else if (position === 'diaga' && x < this.metadata.wSIZE && y < this.metadata.wSIZE) {
            startTile = tile;
            endTile = tiles[x + 1][y + 1];
            shade = DEFAULT_COLOR;
        } else if (position === 'diagb' && x < this.metadata.wSIZE && y < this.metadata.wSIZE) {
            startTile = tiles[x + 1][y];
            endTile = tiles[x][y + 1];
            shade = SHADOW_COLOR;
        }

        if (invert) {
            [startTile, endTile] = [endTile, startTile];
        }

        return {
            location: {
                bottomLeft: new THREE.Vector3(startTile.x, (startTile.elevation || 0.0) + heightOffset, startTile.y),
                topLeft: new THREE.Vector3(startTile.x, (startTile.elevation || 0.0) + heightOffset + WALL_HEIGHT, startTile.y),
                bottomRight: new THREE.Vector3(endTile.x, (endTile.elevation || 0.0) + heightOffset, endTile.y),
                topRight: new THREE.Vector3(endTile.x, (endTile.elevation || 0.0) + heightOffset + WALL_HEIGHT, endTile.y)
            },
            shade
        };
    }

    _drawWall(location, shade, material, geometry, id) {
        geometry.vertices.push(location.bottomLeft, location.topLeft, location.bottomRight, location.topRight);
        const vertexIds = {bottomLeft: id, topLeft: id + 1, bottomRight: id + 2, topRight: id + 3};
        const face1 = createFace(vertexIds.bottomLeft, vertexIds.bottomRight, vertexIds.topLeft, material, shade);
        const face2 = createFace(vertexIds.topRight, vertexIds.bottomRight, vertexIds.topLeft, material, shade);
        geometry.faces.push(face1, face2);
        geometry.faceVertexUvs[0].push([u0, u1, u3], [u2, u1, u3]);
    }

    generateWalls(tiles, name, yOff, W) {
        const materials = [
            new THREE.MeshLambertMaterial({
                vertexColors: THREE.VertexColors,
                side: THREE.FrontSide
            })
        ];

        const materialMap = {};

        const wallDrawingDataGroupedByTexture = {};
        for (let x = 0; x <= this.metadata.wSIZE; x++) {
            for (let y = 0; y <= this.metadata.wSIZE; y++) {
                const tile = tiles[x][y];

                tile.buildings?.[name]?.walls
                    ?.forEach(({type: wallTypeName, position, invert}) => {
                        const {type, texture} = this.walls[wallTypeName];

                        if (type === 'polygon') {
                            wallDrawingDataGroupedByTexture[texture] ||= [];
                            wallDrawingDataGroupedByTexture[texture].push(this._getWallDrawingData(position, tile, tiles, x, y, yOff, invert));
                        }
                    });
            }
        }

        const geometryToDrawTo = new THREE.Geometry();
        let id = 0;

        Object.entries(wallDrawingDataGroupedByTexture)
            .forEach(([texture, wallDrawingData]) => {
                const material = this.materialIndex(materials, materialMap, 'basic', texture, 'buildings/');
                wallDrawingData.forEach(wall => {
                    this._drawWall(wall.location, wall.shade, material, geometryToDrawTo, id);
                    id += 4;
                });
            });

        const mesh = new THREE.Mesh(new THREE.BufferGeometry().fromGeometry(geometryToDrawTo), materials);
        mesh.matrixAutoUpdate = false;
        W.add(mesh);
    }
    
    generateCollisionVisualization(tiles) {
        const geo = new THREE.Geometry();
        const vertices = geo.vertices;

        let c = 0;

        for (let x = 0; x < this.metadata.wSIZE; x++) {
            for (let y = 0; y < this.metadata.wSIZE; y++) {
                const tile = tiles[x][y];
                const pos = new THREE.Vector3(x, 0.05 + (tile.elevation || 0.0), y);
                vertices.push(pos);
                tile.vertex = c++;
            }
        }

        for (let x = 0; x < this.metadata.wSIZE; x++) {
            for (let y = 0; y < this.metadata.wSIZE; y++) {
                const tile = tiles[x][y];

                if (!tile.walkabilityOverriden) {
                    continue;
                }

                const v00 = tiles[x][y].vertex;
                const v10 = tiles[x + 1][y].vertex;
                const v11 = tiles[x + 1][y + 1].vertex;
                const v01 = tiles[x][y + 1].vertex;

                if (v00 === undefined || v10 === undefined || v11 === undefined || v01 === undefined) continue;

                let face1, face2;
                if (tile.orientation === 'diaga') {
                    face1 = new THREE.Face3(v00,v01,v11);
                    face2 = new THREE.Face3(v00,v11,v10);
                } else {
                    face1 = new THREE.Face3(v00,v01,v10);
                    face2 = new THREE.Face3(v10,v01,v11);
                }

                geo.faces.push(face1);
                geo.faces.push(face2);
            }
        }

        return new THREE.BufferGeometry().fromGeometry(geo);
    }

    isRoof(tile, name) {
        if (!tile.buildings) return false;
        if (!tile.buildings[name]) return false;
        return !!(tile.buildings[name].roof || tile.buildings[name].walls);

    }

    roofPosition(tiles,level,x,y) {
        const tile = tiles[x][y];

        if (!tile.buildings) return undefined;
        if (!tile.buildings[level]) return undefined;
        if (!tile.buildings[level].roof) return undefined;

        return tile.buildings[level].roof.position;
    }

    // Returns true if the roof is an 'edge' or 'inner' point
    // this impl is actually broken due to the left edge of the map not knowing about the neighbor
    shouldBeElevated(tiles,level,x,y) {
        let left = x > 0 ? x - 1 : x;
        let up = y > 0 ? y - 1 : y;

        let neighbors = 0;

        let tl = this.roofPosition(tiles,level,left,up);
        if (tl == 'full' || tl == 'br') neighbors++;

        let tr = this.roofPosition(tiles,level,x,up);
        if (tr == 'full' || tr == 'bl') neighbors++;

        let br = this.roofPosition(tiles,level,x,y);
        if (br == 'full' || br == 'tl') neighbors++;

        let bl = this.roofPosition(tiles,level,left,y);
        if (bl == 'full' || bl == 'tr') neighbors++;

        return neighbors == 4;
    }

    // TODO: Roofs of one-tile-wide break the entire roof layer.
    generateRoofs(tiles, name, yOff, W) {
        let materials = [];
        materials.push(new THREE.MeshLambertMaterial( { 
            vertexColors: THREE.VertexColors,
            side: THREE.FrontSide,
            //wireframe: true,
        }));
        let materialMap = {};

        let geometry = new THREE.Geometry();
        let curId = 0;
        for (let x = 0; x <= this.metadata.wSIZE; x++) {
            for (let y = 0; y <= this.metadata.wSIZE; y++) {
                let tile = tiles[x][y];

                if (!tile.buildings) continue;
                if (!tile.buildings[name]) continue;
                if (!tile.buildings[name].roof) continue;

                // skip unnecessary roof
                if (tile.buildings[name].roof.type == 'empty') continue;

                let tt = this.roofs[tile.buildings[name].roof.type];
                if (!tt) {
                    continue;
                }

                let e0 = false, e1 = false, e2 = false, e3 = false;
                let ecount = 0;
                let v0 = new THREE.Vector3(x, tile.elevation + yOff, y);
                if (this.shouldBeElevated(tiles,name,x,y)) { v0.y += ROOF_HEIGHT; e0 = true; ecount++; }
                let v1 = new THREE.Vector3(x+1, tile.elevation + yOff, y);
                if (this.shouldBeElevated(tiles,name,x+1,y)) { v1.y += ROOF_HEIGHT; e1 = true; ecount++; }
                let v2 = new THREE.Vector3(x+1, tile.elevation + yOff, y+1);
                if (this.shouldBeElevated(tiles,name,x+1,y+1)) { v2.y += ROOF_HEIGHT; e2 = true; ecount++; }
                let v3 = new THREE.Vector3(x, tile.elevation + yOff, y+1);
                if (this.shouldBeElevated(tiles,name,x,y+1)) { v3.y += ROOF_HEIGHT; e3 = true; ecount++; }

                geometry.vertices.push(v0); let A = curId++;
                geometry.vertices.push(v1); let B = curId++;
                geometry.vertices.push(v2); let C = curId++;
                geometry.vertices.push(v3); let D = curId++;

                // todo: add prefix roofs/
                let topIndex = this.materialIndex(
                    materials, materialMap, 'basic', 
                    tt.top, 'buildings/');
                let sideIndex = this.materialIndex(
                    materials, materialMap, 'basic', 
                    tt.side, 'buildings/');

                // this is almost definitely wrong?
                let flipFaces = false;
                if (ecount == 1 && (e1 || e3)) flipFaces = true;
                if (ecount == 3 && (!e0 || !e2)) flipFaces = true;

                if (tile.buildings[name].roof.position == 'full') {
                    //console.log([ecount, e0, e1, e2, e3]);
                    if (flipFaces) {
                        if (e0 && e1 && e3) {
                            geometry.faces.push(createFace(A, B, D, topIndex));
                            geometry.faceVertexUvs[0].push([u0, u1, u3]);
                        } else {
                            geometry.faces.push(createFace(A, B, D, sideIndex));
                            if (ecount == 3) {
                                geometry.faceVertexUvs[0].push([u0, uHalfLeft, uHalf]);
                            } else if (e3) {
                                geometry.faceVertexUvs[0].push([u1,u0,u2]);
                            } else if (e1) {
                                geometry.faceVertexUvs[0].push([u0,u3,u1]);
                            } else {
                                console.log("Sadness.");
                            }
                        }

                        if (e1 && e2 && e3) {
                            geometry.faces.push(createFace(B, C, D, topIndex));
                            geometry.faceVertexUvs[0].push([u1, u2, u3]);
                        } else {
                            geometry.faces.push(createFace(B, C, D, sideIndex));
                            if (ecount == 3) {
                                geometry.faceVertexUvs[0].push([uHalf, u0,uHalfLeft]);
                            } else if (e1) {
                                geometry.faceVertexUvs[0].push([u2,u1,u0]);
                            } else if (e3) {
                                geometry.faceVertexUvs[0].push([u1, u0, u3]);
                            } else {
                                console.log("Sadness.");
                            }
                        }
                    } else {
                        if (e0 && e1 && e2) {
                            geometry.faces.push(createFace(A, B, C,topIndex));
                            geometry.faceVertexUvs[0].push([u0, u1, u2]);
                        } else {
                            geometry.faces.push(createFace(A, B, C,sideIndex));
                            if (ecount == 1) {
                                if (e0) {
                                    geometry.faceVertexUvs[0].push([u2,u1,u0]);   
                                } else if (e2) {
                                    geometry.faceVertexUvs[0].push([u1,u0,u3]);
                                } else {
                                    console.log("Sadness");
                                }
                            } else if (ecount == 2) {
                                if (e0 && e1) {
                                    geometry.faceVertexUvs[0].push([u3,u2,u1]);
                                } else if (e1 && e2) {
                                    geometry.faceVertexUvs[0].push([u0,u3,u2]);
                                } else if (e2 && e3) {
                                    geometry.faceVertexUvs[0].push([u1,u0,u3]);
                                } else if (e0 && e3) {
                                    geometry.faceVertexUvs[0].push([u2, u1, u0]);
                                } else {
                                    console.log("Sadness");
                                }
                            } else if (ecount == 3) {
                                if (!e1) {
                                    geometry.faceVertexUvs[0].push([uHalfLeft, u0, uHalf]);
                                } else {
                                    console.log("Sadness");
                                }
                            }
                        }

                        if (e0 && e2 && e3) {
                            geometry.faces.push(createFace(A, C, D, topIndex));
                            geometry.faceVertexUvs[0].push([u0, u2, u3]);
                        } else {
                            geometry.faces.push(createFace(A, C, D, sideIndex));
                            if (ecount == 1) {
                                if (e0) {
                                    geometry.faceVertexUvs[0].push([u3, u1, u0]);
                                } else if (e2) {
                                    geometry.faceVertexUvs[0].push([u0, u2, u1]);
                                } else {
                                    console.log("Sadness");
                                }
                            } else if (ecount == 2) {
                                if (e0 && e1) {
                                    geometry.faceVertexUvs[0].push([u3,u1,u0]);
                                } else if (e1 && e2) {
                                    geometry.faceVertexUvs[0].push([u0,u2,u1]);
                                } else if (e2 && e3) {
                                    geometry.faceVertexUvs[0].push([u1,u3,u2]);
                                } else if (e0 && e3) {
                                    geometry.faceVertexUvs[0].push([u2, u0, u3]);
                                } else {
                                    console.log("Sadness");
                                }
                            } else if (ecount == 3) {
                                if (!e3) {
                                    geometry.faceVertexUvs[0].push([uHalf,uHalfLeft, u0]);
                                } else {
                                    console.log("Sadness");
                                }
                            }
                        }
                    }
                } else if (tile.buildings[name].roof.position == 'tl') {
                    geometry.faces.push(createFace(A, B, D, sideIndex));
                    geometry.faceVertexUvs[0].push([uHalf, u1, u0]);
                } else if (tile.buildings[name].roof.position == 'tr') {
                    geometry.faces.push(createFace(A, B, C, sideIndex));
                    geometry.faceVertexUvs[0].push([u0, uHalf, u1]);
                } else if (tile.buildings[name].roof.position == 'bl') {
                    geometry.faces.push(createFace(A, C, D, sideIndex));
                    geometry.faceVertexUvs[0].push([u1, u0, uHalf]);
                } else if (tile.buildings[name].roof.position == 'br') {
                    geometry.faces.push(createFace(B, C, D, sideIndex));
                    geometry.faceVertexUvs[0].push([u0, uHalf, u1]);
                }
            }
        }

        let mesh = new THREE.Mesh(geometry, materials);
        mesh.matrixAutoUpdate = false;
        W.add(mesh);
    }

    generateFloors(tiles, name, yOff, W) {
        const materials = [
            new THREE.MeshLambertMaterial({
                vertexColors: THREE.VertexColors,
                side: THREE.FrontSide
            })
        ];

        const materialMap = {};

        const geometry = new THREE.Geometry();
        let curId = 0;

        for (let x = 0; x <= this.metadata.wSIZE; x++) {
            for (let y = 0; y <= this.metadata.wSIZE; y++) {
                const tile = tiles[x][y];
                const floor = tile.buildings?.[name]?.floor;

                if (!floor) continue;

                geometry.vertices.push(new THREE.Vector3(x, tile.elevation + yOff, y));
                let v00 = curId++;
                geometry.vertices.push(new THREE.Vector3(x + 1, tile.elevation + yOff, y));
                let v10 = curId++;
                geometry.vertices.push(new THREE.Vector3(x + 1, tile.elevation + yOff, y + 1));
                let v11 = curId++;
                geometry.vertices.push(new THREE.Vector3(x, tile.elevation + yOff, y + 1));
                let v01 = curId++;

                let material1 = this.materialIndex(materials, materialMap, 'basic', floor.texture1, 'buildings/floors/');
                let material2 = this.materialIndex(materials, materialMap, 'basic', floor.texture2, 'buildings/floors/');

                let face1, face2;
                if (floor.orientation === 'diaga') {
                    face1 = new THREE.Face3(v00, v01, v11);
                    face2 = new THREE.Face3(v00, v11, v10);

                    if (material1) geometry.faceVertexUvs[0].push(diaga_uvs_0);
                    if (material2) geometry.faceVertexUvs[0].push(diaga_uvs_1);
                } else {
                    face1 = new THREE.Face3(v00, v01, v10);
                    face2 = new THREE.Face3(v10, v01, v11);

                    if (material1) geometry.faceVertexUvs[0].push(diagb_uvs_0);
                    if (material2) geometry.faceVertexUvs[0].push(diagb_uvs_1);
                }

                face1.materialIndex = material1;
                face2.materialIndex = material2;

                if (material1) geometry.faces.push(face1);
                if (material2) geometry.faces.push(face2);
            }
        }

        let mesh = new THREE.Mesh(geometry, materials);
        mesh.matrixAutoUpdate = false;
        W.add(mesh);
    }

    generateLevel(tiles, level, group) {
        let name = "level" + level; // 0-3
        let yOff = level * WALL_HEIGHT;

        // todo jasper
        // seems like ground floor is not in here, all other floors are though
        this.generateFloors(tiles, name, yOff, group);
        this.generateWalls(tiles, name, yOff, group);
        this.generateRoofs(tiles, name, yOff, group);
    }

    setTilePositions(tiles) {
        for (let x = 0; x <= this.metadata.wSIZE; x++) {
            for (let y = 0; y <= this.metadata.wSIZE; y++) {
                Object.assign(tiles[x][y], {x, y});
            }
        }
    }

    // Creates the level meshes in the walls and roofs groups.
    // Wall group always visible, while roofs disappear/fade when you're indoors.
    generateBuildings(tiles, W, R) {
        this.generateLevel(tiles, 0, W);

        this.generateLevel(tiles, 1, R);
        this.generateLevel(tiles, 2, R);
        this.generateLevel(tiles, 3, R);
    }

    createMesh(params, mesh) {
        if (!this.textureManager) throw "Texture manager missing."
        if (!this.walls) throw "Wall definitions missing."
        if (!this.roofs) throw "Roof definitions missing."

        /* For floor on ground level */
        //let preparedVertices = this.prepareVertices(mesh);
        const tileGeometries = this.prepareVertices(mesh);
        const tileMeshes = this.populateGeometry(mesh, tileGeometries);
        //let threeMesh = this.populateGeometry(mesh, preparedVertices);

        //let geo = new THREE.WireframeGeometry(threeMesh.geometry);
        //let mat = new THREE.LineBasicMaterial({color: 0x000000});
        //let wireframe = new THREE.LineSegments(geo, mat);

        //let col_geo = this.generateCollisionVisualization(mesh, preparedVertices);
        //let col_mat = new THREE.MeshBasicMaterial({color: 0xff0000});
        //let collision = new THREE.Mesh(col_geo, col_mat);

        let walls = new THREE.Group();
        let roofs = new THREE.Group();
        this.setTilePositions(mesh);
        this.generateBuildings(mesh, walls, roofs);

        // todo jasper removed
        /*if (params.offset) {
            let x = params.offset.mx * this.metadata.wSIZE;
            let z = params.offset.my * this.metadata.wSIZE;
            let k = params.offset.mx + "," + params.offset.my;
            tileMeshes.forEach((tileMesh, index) => {
                tileMesh.name = 'mesh-' + k + '' + index;
                tileMesh.position.set(x, 0, z);
            });
            threeMesh.name = "mesh-" + k;
            threeMesh.position.set(x, 0, z);
            threeMesh.updateMatrix();

            walls.position.set(x, 0, z);
            walls.name = "walls-" + k;
            walls.updateMatrix();

            roofs.position.set(x, 0, z);
            roofs.name = "roofs-" + k;
            roofs.updateMatrix();
        }*/

        return {
            terrain: new TerrainMesh(this.metadata, params, mesh, tileMeshes, walls, roofs, null, null)
        }
    }
}

var BGE;

/*function exportCollada(mesh, name) {
    var exporter = new THREE.ColladaExporter();

    var { data, textures } = exporter.parse(mesh);

    const zip = new JSZip();
    zip.file( 'myCollada.dae', data );
    textures.forEach( tex => zip.file( `textures/${ tex.name }.${ tex.ext }`, tex.data ) );
    
    zip.generateAsync({type:"blob"}).then((blob) => {
        saveAs(blob, "hello.zip");
    }, (err) => {
        console.log(":(> " + err);
    })
}*/